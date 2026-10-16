import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessKeyCache } from "../../src/admin/auth/access";
import { archiveParts } from "../../src/core/db/schema";
import { adminApp, auditRows } from "../helpers/admin";
import { isolateArchive, seedBatch } from "../helpers/archive";
import { fakeArchive, testDeps } from "../helpers/deps";

describe("archives API (spec §7.6)", () => {
	const archive = fakeArchive();
	const deps = testDeps({ archive });
	beforeEach(async () => {
		clearAccessKeyCache();
		await isolateArchive(deps);
	});

	async function batchWithPart(
		status: "verified" | "building" | "expired" | "failed" | "purged",
		withFiles = true,
	) {
		const b = await seedBatch(deps, { status, withFiles });
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
		clearAccessKeyCache(); // second app minted fresh keys under the same kid
		expect(
			(
				await (
					await adminApp(deps, { role: "viewer" })
				).request("GET", `/archives/${b.id}/parts/1`)
			).status,
		).toBe(403);
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
		clearAccessKeyCache(); // second app minted fresh keys under the same kid
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
