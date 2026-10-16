import { beforeEach, describe, expect, it } from "vitest";
import { clearAccessKeyCache } from "../../src/admin/auth/access";
import { backups } from "../../src/core/db/schema";
import { adminApp, auditRows } from "../helpers/admin";
import { fakeBackup, testDeps } from "../helpers/deps";

describe("backups API", () => {
	beforeEach(async () => {
		clearAccessKeyCache();
	});

	async function cleanBackups(deps: ReturnType<typeof testDeps>) {
		await deps.db.delete(backups);
	}

	it("an operator gets 403 on both routes", async () => {
		const deps = testDeps();
		await cleanBackups(deps);
		const app = await adminApp(deps, { role: "operator" });
		expect((await app.request("GET", "/backups/summary")).status).toBe(403);
		expect((await app.request("POST", "/backups/run", {})).status).toBe(403);
	});

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
