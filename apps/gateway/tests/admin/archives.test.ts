import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { archiveParts, auditLogs } from "../../src/core/db/schema";
import { ARCHIVE_LAST_RUN_KEY, upsertSetting } from "../../src/core/settings";
import { adminApp, auditRows, seedAdminProject } from "../helpers/admin";
import { isolateArchive, seedBatch } from "../helpers/archive";
import { fakeArchive, testDeps } from "../helpers/deps";

describe("archives API (spec §7.6)", () => {
	const archive = fakeArchive();
	const deps = testDeps({ archive });
	beforeEach(async () => {
		await seedAdminProject();
		await isolateArchive(deps);
	});

	async function batchWithPart(
		status: "verified" | "building" | "expired" | "failed" | "purged",
		withFiles = true,
		kind: "events" | "audit" = "events",
	) {
		const b = await seedBatch(deps, { status, withFiles, kind });
		const key = withFiles
			? `archive/2026/01/02/${b.id}/part-0001.ndjson.gz`
			: null;
		if (key) await deps.payloads.put(key, new Uint8Array([31, 139, 8]));
		await deps.db.insert(archiveParts).values({
			batchId: b.id,
			partNo: 1,
			r2Key: key,
			itemCount: 1,
			bytes: 3,
			sha256: null,
			firstId: "evt_a",
			lastId: "evt_a",
		});
		return b;
	}

	it("lists batches with parts, newest first", async () => {
		const a = await batchWithPart("verified");
		const res = await (await adminApp(deps, { role: "viewer" })).request(
			"GET",
			"/archives?kind=events",
		);
		const body = await res.json<{
			data: {
				id: string;
				status: string;
				parts: { part_no: number; downloadable: boolean }[];
			}[];
		}>();
		expect(body.data[0]).toMatchObject({
			id: a.id,
			status: "verified",
			parts: [{ part_no: 1, downloadable: true }],
		});
	});

	it("filters by status and day range and pages by (created_at, id)", async () => {
		const mk = (
			day: string,
			status: "verified" | "failed",
			createdAt: number,
		) => seedBatch(deps, { day, status, createdAt });
		const jan1 = await mk("2026-01-01", "verified", 100);
		const jan2 = await mk("2026-01-02", "verified", 200);
		const jan3 = await mk("2026-01-03", "verified", 200);
		await mk("2026-01-02", "failed", 300);
		const app = await adminApp(deps, { role: "viewer" });
		const qs = "status=verified&from_day=2026-01-02&to_day=2026-01-03&limit=1";
		const seen: string[] = [];
		let cursor: string | null = null;
		do {
			const res = await app.request(
				"GET",
				`/archives?${qs}${cursor ? `&cursor=${cursor}` : ""}`,
			);
			expect(res.status).toBe(200);
			const page = await res.json<{
				data: { id: string; parts: unknown[] }[];
				next_cursor: string | null;
			}>();
			seen.push(...page.data.map((b) => b.id));
			cursor = page.next_cursor;
		} while (cursor);
		expect(seen).toEqual([jan3.id, jan2.id]);
		expect(seen).not.toContain(jan1.id);
	});

	it("returns an empty page when nothing matches", async () => {
		const res = await (await adminApp(deps, { role: "viewer" })).request(
			"GET",
			"/archives?kind=audit",
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ data: [], next_cursor: null });
	});

	it("rejects an invalid query or cursor with 400", async () => {
		const app = await adminApp(deps, { role: "viewer" });
		const bad = await app.request("GET", "/archives?limit=0");
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ error: "invalid_request" });
		const cur = await app.request("GET", "/archives?cursor=zz");
		expect(cur.status).toBe(400);
		expect(await cur.json()).toMatchObject({
			issues: [{ path: "cursor", code: "invalid_cursor" }],
		});
	});

	it("returns 404 for an unknown part or a part whose R2 object is gone, without auditing", async () => {
		const b = await batchWithPart("verified");
		const app = await adminApp(deps, { role: "operator" });
		expect((await app.request("GET", `/archives/${b.id}/parts/2`)).status).toBe(
			404,
		);
		await deps.payloads.delete(
			`archive/2026/01/02/${b.id}/part-0001.ndjson.gz`,
		);
		const gone = await app.request("GET", `/archives/${b.id}/parts/1`);
		expect(gone.status).toBe(404);
		expect(await gone.json()).toEqual({ error: "not_found" });
		expect(await auditRows(deps, b.id)).toEqual([]);
	});

	it("streams a part to operators and audits the download (M5-23)", async () => {
		const b = await batchWithPart("verified");
		const res = await (await adminApp(deps, { role: "operator" })).request(
			"GET",
			`/archives/${b.id}/parts/1`,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/gzip");
		expect(res.headers.get("content-disposition")).toContain(".ndjson.gz");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(
			new Uint8Array([31, 139, 8]),
		);
		expect((await auditRows(deps, b.id)).map((a) => a.action)).toEqual([
			"archive.downloaded",
		]);
		expect(
			(
				await (
					await adminApp(deps, { role: "viewer" })
				).request("GET", `/archives/${b.id}/parts/1`)
			).status,
		).toBe(403);
	});

	it("serves audit archive parts only to roles with audit.read", async () => {
		const b = await batchWithPart("verified", true, "audit");
		const denied = await (await adminApp(deps, { role: "operator" })).request(
			"GET",
			`/archives/${b.id}/parts/1`,
		);
		expect(denied.status).toBe(403);
		expect(await denied.json()).toEqual({
			error: "forbidden",
			required: "audit.read",
		});
		expect(await auditRows(deps, b.id)).toEqual([]);
		const res = await (await adminApp(deps, { role: "admin" })).request(
			"GET",
			`/archives/${b.id}/parts/1`,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toContain(
			"hookflare-audit-",
		);
	});

	it("streams a purged batch with files to operators", async () => {
		const b = await batchWithPart("purged");
		const res = await (await adminApp(deps, { role: "operator" })).request(
			"GET",
			`/archives/${b.id}/parts/1`,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/gzip");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(
			new Uint8Array([31, 139, 8]),
		);
	});

	it.each([
		["building", true],
		["expired", true],
		["failed", true],
		["verified", false],
	] as const)(
		"returns 404 for a %s batch (files: %s)",
		async (status, withFiles) => {
			const b = await batchWithPart(status, withFiles);
			expect(
				(
					await (
						await adminApp(deps)
					).request("GET", `/archives/${b.id}/parts/1`)
				).status,
			).toBe(404);
		},
	);

	it("starts a manual run and audits it", async () => {
		const res = await (await adminApp(deps)).request(
			"POST",
			"/archives/run",
			{},
		);
		expect(res.status).toBe(202);
		const { instance_id } = await res.json<{ instance_id: string }>();
		expect(instance_id).toMatch(/^archive-manual-/);
		expect(archive.created).toContain(instance_id);
		expect((await auditRows(deps, instance_id)).map((a) => a.action)).toEqual([
			"archive.run_started",
		]);
	});

	it("refuses a manual run while the last run is still running", async () => {
		const running = fakeArchive("running");
		const busy = testDeps({ archive: running });
		await upsertSetting(
			busy.db,
			ARCHIVE_LAST_RUN_KEY,
			{ instance_id: "archive-live", started_at: 1 },
			1,
		);
		const started = async () =>
			(
				await busy.db
					.select()
					.from(auditLogs)
					.where(eq(auditLogs.action, "archive.run_started"))
			).length;
		const before = await started();
		const res = await (await adminApp(busy)).request(
			"POST",
			"/archives/run",
			{},
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "archive_running" });
		expect(running.created).toEqual([]);
		expect(await started()).toBe(before);
	});

	it("logs the instance id when the audit write fails after the run starts", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = await adminApp(deps);
		const batch = vi
			.spyOn(deps.db, "batch")
			.mockRejectedValueOnce(new Error("d1 down"));
		try {
			const res = await app.request("POST", "/archives/run", {});
			expect(res.status).toBe(500);
			const [instanceId] = archive.created.slice(-1);
			expect(instanceId).toMatch(/^archive-manual-/);
			const logged = errorSpy.mock.calls.map((c) => String(c[0]));
			expect(
				logged.some(
					(l) =>
						l.includes("archive.run_audit_failed") && l.includes(instanceId),
				),
			).toBe(true);
		} finally {
			batch.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("previews how many events become eligible", async () => {
		const res = await (await adminApp(deps)).request(
			"GET",
			"/archives/preview?hot_retention_days=1&failed_retention_days=1",
		);
		expect(await res.json()).toEqual({
			eligible: expect.any(Number),
			currently_eligible: expect.any(Number),
		});
		expect(
			(
				await (
					await adminApp(deps)
				).request(
					"GET",
					"/archives/preview?hot_retention_days=0&failed_retention_days=1",
				)
			).status,
		).toBe(400);
	});
});
