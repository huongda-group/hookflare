import { DEFAULT_STORAGE_SETTINGS } from "@hookflare/shared";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/core/db/archive";
import { backups } from "../../src/core/db/schema";
import { dumpPage } from "../../src/jobs/backup/dump";
import { writeManifest } from "../../src/jobs/backup/manifest";
import { expireBackups } from "../../src/jobs/backup/retention";
import type { TableInfo } from "../../src/jobs/backup/tables";
import { listTables } from "../../src/jobs/backup/tables";
import { verifyBackup } from "../../src/jobs/backup/verify";
import { listKeys } from "../helpers/archive";
import { testDeps } from "../helpers/deps";

const deps = testDeps();
const DAY = "2026-10-16";

async function clean() {
	await deps.db.delete(backups);
	const keys = await listKeys(deps.backups, "test/backup/steps/");
	if (keys.length) await deps.backups.delete(keys);
}

beforeEach(() => clean());

async function migrationNames(): Promise<string[]> {
	const rows = await deps.db.all<{ name: string }>(
		sql`SELECT name FROM d1_migrations ORDER BY id`,
	);
	return rows.map((r) => r.name);
}

async function seedBackup(id: string, prefix: string, startedAt: number) {
	await deps.db.insert(backups).values({
		id,
		day: DAY,
		status: "running",
		prefix,
		instanceId: "test-instance",
		trigger: "manual",
		startedAt,
	});
}

/** Dump every non-empty table under prefix; returns the collected PartMeta list. */
async function dumpAll(prefix: string) {
	const tables = await listTables(deps.db);
	const parts: Awaited<ReturnType<typeof dumpPage>>["part"][] = [];
	const nonEmpty: TableInfo[] = [];
	const partNoByTable = new Map<string, number>();
	for (const table of tables) {
		let cursor: string | number | null = null;
		for (;;) {
			const partNo = (partNoByTable.get(table.name) ?? 0) + 1;
			partNoByTable.set(table.name, partNo);
			const { part, next } = await dumpPage(
				deps,
				table,
				prefix,
				partNo,
				cursor,
			);
			if (part) {
				parts.push(part);
				if (!nonEmpty.includes(table)) nonEmpty.push(table);
			}
			if (next === null) break;
			cursor = next;
		}
	}
	return {
		tables: nonEmpty,
		parts: parts.filter((p) => p !== null),
	};
}

describe("writeManifest", () => {
	it("lists applied d1_migrations and per-table rows equal to the parts sum", async () => {
		const prefix = "test/backup/steps/manifest/";
		await seedBackup("bk_manifest", prefix, Date.now());
		const { tables, parts } = await dumpAll(prefix);
		expect(parts.length).toBeGreaterThan(0);

		const manifest = await writeManifest(
			deps,
			"bk_manifest",
			tables,
			parts,
			Date.now(),
		);

		expect(manifest.version).toBe(1);
		expect(manifest.backup_id).toBe("bk_manifest");
		expect(manifest.prefix).toBe(prefix);
		expect(manifest.d1_migrations).toEqual(await migrationNames());
		for (const t of manifest.tables) {
			const sum = parts
				.filter((p) => p.table === t.name)
				.reduce((s, p) => s + p.rows, 0);
			expect(t.rows).toBe(sum);
		}

		const obj = await deps.backups.get(`${prefix}manifest.json`);
		expect(obj).not.toBeNull();
		expect(JSON.parse(await (obj as R2ObjectBody).text())).toMatchObject({
			version: 1,
			backup_id: "bk_manifest",
		});

		const [row] = await deps.db
			.select()
			.from(backups)
			.where(sql`id = 'bk_manifest'`);
		expect(row.partCount).toBe(parts.length);
		expect(row.bytes).toBeGreaterThan(0);
		expect(JSON.parse(row.rowCountsJson)).toEqual(
			Object.fromEntries(manifest.tables.map((t) => [t.name, t.rows])),
		);
	});
});

describe("verifyBackup", () => {
	it("verify ok sets the status to verified", async () => {
		const prefix = "test/backup/steps/verify-ok/";
		await seedBackup("bk_verify_ok", prefix, Date.now());
		const { tables, parts } = await dumpAll(prefix);
		await writeManifest(deps, "bk_verify_ok", tables, parts, Date.now());

		const result = await verifyBackup(deps, "bk_verify_ok");
		expect(result).toEqual({ ok: true });

		const [row] = await deps.db
			.select()
			.from(backups)
			.where(sql`id = 'bk_verify_ok'`);
		expect(row.status).toBe("verified");
		expect(row.finishedAt).not.toBeNull();
	});

	it("verify mismatch fails and names the overwritten part", async () => {
		const prefix = "test/backup/steps/verify-bad/";
		await seedBackup("bk_verify_bad", prefix, Date.now());
		const { tables, parts } = await dumpAll(prefix);
		expect(parts.length).toBeGreaterThan(0);
		await writeManifest(deps, "bk_verify_bad", tables, parts, Date.now());

		const victim = parts[0];
		await deps.backups.put(victim.key, new TextEncoder().encode("tampered"));

		const result = await verifyBackup(deps, "bk_verify_bad");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(victim.key);

		const [row] = await deps.db
			.select()
			.from(backups)
			.where(sql`id = 'bk_verify_bad'`);
		expect(row.status).toBe("failed");
		expect(row.error).toContain(victim.key);
	});
});

describe("expireBackups", () => {
	it("retention keeps newest verified: deletes the 50-day backup, keeps the 40-day one", async () => {
		const now = Date.now();
		const oldPrefix = "test/backup/steps/old50/";
		const keepPrefix = "test/backup/steps/keep40/";
		await seedBackup("bk_old50", oldPrefix, now - 50 * DAY_MS);
		await seedBackup("bk_keep40", keepPrefix, now - 40 * DAY_MS);
		await deps.db
			.update(backups)
			.set({ status: "verified" })
			.where(sql`id IN ('bk_old50', 'bk_keep40')`);
		await deps.backups.put(`${oldPrefix}part.ndjson.gz`, new Uint8Array([1]));
		await deps.backups.put(`${keepPrefix}part.ndjson.gz`, new Uint8Array([2]));

		const result = await expireBackups(
			deps,
			{ ...DEFAULT_STORAGE_SETTINGS, backup_retention_days: 35 },
			now,
		);
		expect(result.deleted).toEqual(["bk_old50"]);

		const remaining = await deps.db.select({ id: backups.id }).from(backups);
		expect(remaining.map((r) => r.id)).toEqual(["bk_keep40"]);
		expect(await listKeys(deps.backups, oldPrefix)).toEqual([]);
		expect(await listKeys(deps.backups, keepPrefix)).toHaveLength(1);
	});

	it("retention off: with backup_enabled false, nothing is deleted", async () => {
		const now = Date.now();
		const prefix = "test/backup/steps/off/";
		await seedBackup("bk_off", prefix, now - 50 * DAY_MS);
		await deps.db
			.update(backups)
			.set({ status: "verified" })
			.where(sql`id = 'bk_off'`);
		await deps.backups.put(`${prefix}part.ndjson.gz`, new Uint8Array([3]));

		const result = await expireBackups(
			deps,
			{ ...DEFAULT_STORAGE_SETTINGS, backup_enabled: false },
			now,
		);
		expect(result.deleted).toEqual([]);

		const remaining = await deps.db.select({ id: backups.id }).from(backups);
		expect(remaining.map((r) => r.id)).toEqual(["bk_off"]);
		expect(await listKeys(deps.backups, prefix)).toHaveLength(1);
	});
});
