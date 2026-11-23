import { beforeEach, describe, expect, it, vi } from "vitest";
import { backups } from "../../src/core/db/schema";
import { adminApp, auditRows, seedAdminProject } from "../helpers/admin";
import { fakeBackup, testDeps } from "../helpers/deps";
import { faultyDeps } from "../helpers/faults";

describe("backups API", () => {
	beforeEach(seedAdminProject);
	async function cleanBackups(deps: ReturnType<typeof testDeps>) {
		await deps.db.delete(backups);
	}

	it.each(["viewer", "operator"] as const)(
		"a %s reads the summary but gets 403 on POST /run",
		async (role) => {
			const deps = testDeps();
			await cleanBackups(deps);
			const app = await adminApp(deps, { role });
			expect((await app.request("GET", "/backups/summary")).status).toBe(200);
			expect((await app.request("POST", "/backups/run", {})).status).toBe(403);
		},
	);

	it("an admin POST /run returns 202, inserts a backups row, and audits backup.run", async () => {
		const deps = testDeps();
		await cleanBackups(deps);
		const res = await (await adminApp(deps)).request(
			"POST",
			"/backups/run",
			{},
		);
		expect(res.status).toBe(202);
		const body = await res.json<{
			backup_id: string;
			instance_id: string;
		}>();
		expect(body.backup_id).toMatch(
			/^backup-\d{4}-\d{2}-\d{2}-manual-[a-z0-9]+$/,
		);
		expect(body.instance_id).toBe(body.backup_id);
		const rows = await deps.db.select().from(backups);
		expect(rows.map((r) => r.id)).toEqual([body.backup_id]);
		expect(rows[0]).toMatchObject({ status: "running", trigger: "manual" });
		const audits = await auditRows(deps, body.backup_id);
		expect(audits.map((a) => a.action)).toEqual(["backup.run"]);
		expect(audits[0]).toMatchObject({
			resourceType: "backup",
			resourceId: body.backup_id,
		});
	});

	it("a second POST while running returns 409 backup_running (Review Focus 5)", async () => {
		const deps = testDeps({ backup: fakeBackup("running") });
		await cleanBackups(deps);
		const app = await adminApp(deps);
		const first = await app.request("POST", "/backups/run", {});
		expect(first.status).toBe(202);
		const second = await app.request("POST", "/backups/run", {});
		expect(second.status).toBe(409);
		expect(await second.json()).toEqual({ error: "backup_running" });
		const rows = await deps.db.select().from(backups);
		expect(rows).toHaveLength(1);
	});

	it("two concurrent POSTs start exactly one backup", async () => {
		const backup = fakeBackup("running");
		const deps = testDeps({ backup });
		await cleanBackups(deps);
		const app = await adminApp(deps);
		const results = await Promise.all([
			app.request("POST", "/backups/run", {}),
			app.request("POST", "/backups/run", {}),
		]);
		expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
		expect(await deps.db.select().from(backups)).toHaveLength(1);
		expect(backup.created).toHaveLength(1);
	});

	it("a failed audit write leaves no backups row and starts no workflow", async () => {
		const backup = fakeBackup("running");
		const base = testDeps({ backup });
		await cleanBackups(base);
		const deps = faultyDeps(base, {
			d1: [{ match: /insert into "audit_logs"/i }],
		});
		const res = await (await adminApp(deps)).request(
			"POST",
			"/backups/run",
			{},
		);
		expect(res.status).toBe(500);
		expect(await base.db.select().from(backups)).toHaveLength(0);
		expect(backup.created).toHaveLength(0);
	});

	it("marks the row failed when the Workflow does not start, so the next run is not blocked", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const backup = fakeBackup("running");
		backup.create = async () => {
			throw new Error("workflows unavailable");
		};
		const deps = testDeps({ backup });
		await cleanBackups(deps);
		try {
			const app = await adminApp(deps);
			const res = await app.request("POST", "/backups/run", {});
			expect(res.status).toBe(500);
			expect(await res.json()).toMatchObject({ error: "internal_error" });
			const rows = await deps.db.select().from(backups);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				status: "failed",
				error: "start failed: Error: workflows unavailable",
			});
			expect((await auditRows(deps, rows[0].id)).map((a) => a.action)).toEqual([
				"backup.run",
			]);
			backup.create = fakeBackup("running").create;
			expect((await app.request("POST", "/backups/run", {})).status).toBe(202);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("summary returns last_verified from the newest verified row", async () => {
		const deps = testDeps();
		await cleanBackups(deps);
		const now = Date.now();
		await deps.db.insert(backups).values([
			{
				id: "bk-old",
				day: "2026-10-14",
				status: "verified",
				prefix: "d1/2026/10/14/bk-old/",
				rowCountsJson: JSON.stringify({ a: 1 }),
				bytes: 10,
				instanceId: "bk-old",
				trigger: "cron",
				startedAt: now - 2000,
				finishedAt: now - 1999,
			},
			{
				id: "bk-new",
				day: "2026-10-15",
				status: "verified",
				prefix: "d1/2026/10/15/bk-new/",
				rowCountsJson: JSON.stringify({ a: 2 }),
				bytes: 20,
				instanceId: "bk-new",
				trigger: "cron",
				startedAt: now - 1000,
				finishedAt: now - 999,
			},
		]);
		const res = await (await adminApp(deps)).request("GET", "/backups/summary");
		expect(res.status).toBe(200);
		const body = await res.json<{
			last_verified: { id: string; bytes: number; rows: number } | null;
		}>();
		expect(body.last_verified).toMatchObject({
			id: "bk-new",
			bytes: 20,
			rows: 2,
		});
	});
});
