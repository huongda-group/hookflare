import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	DEFAULT_STORAGE_SETTINGS,
	type StorageSettings,
} from "@hookflare/shared";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BackupParams,
	isBackupRunning,
	readBackupSummary,
	startBackupRun,
} from "../../src/core/backup-run";
import { backups, settings } from "../../src/core/db/schema";
import { createLogger } from "../../src/core/log";
import type { StepFn } from "../../src/core/workflow";
import type { Deps } from "../../src/deps";
import { runBackup } from "../../src/jobs/backup/run";
import { ident, listTables } from "../../src/jobs/backup/tables";
import { BACKUP_CRON, runScheduled } from "../../src/jobs/scheduled";
import { listKeys } from "../helpers/archive";
import { fakeBackup, testDeps } from "../helpers/deps";
import { faultyR2 } from "../helpers/faults";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const logger = createLogger({ LOG_LEVEL: "error" });
const plain: StepFn = (_name, fn) => fn();

/** Fake backup Workflow binding that also records create params. */
function recordingBackup(status = "complete") {
	const created: { id: string; params: unknown }[] = [];
	const backup = {
		created,
		async create(opts?: { id?: string; params?: unknown }) {
			const id = opts?.id ?? crypto.randomUUID();
			if (created.some((c) => c.id === id))
				throw new Error(`instance.already_exists: ${id}`);
			created.push({ id, params: opts?.params });
			return { id };
		},
		async get(id: string) {
			if (!created.some((c) => c.id === id) && status === "missing")
				throw new Error("instance.not_found");
			return { id, status: async () => ({ status }) };
		},
	};
	return backup as unknown as Workflow & { created: typeof created };
}

async function setStorage(deps: Deps, s: Partial<StorageSettings>) {
	await deps.db.delete(settings).where(eq(settings.key, "storage"));
	await deps.db.insert(settings).values({
		key: "storage",
		valueJson: JSON.stringify({ ...DEFAULT_STORAGE_SETTINGS, ...s }),
		updatedAt: 1,
	});
}

async function cleanBackups(deps: Deps) {
	await deps.db.delete(backups);
	const keys = await listKeys(deps.backups, "d1/");
	if (keys.length) await deps.backups.delete(keys);
}

async function rowCounts(deps: Deps): Promise<Record<string, number>> {
	const tables = await listTables(deps.db);
	const out: Record<string, number> = {};
	for (const t of tables) {
		const [r] = await deps.db.all<{ n: number }>(
			sql`SELECT COUNT(*) AS n FROM ${sql.raw(ident(t.name))}`,
		);
		out[t.name] = r.n;
	}
	return out;
}

async function readManifest(deps: Deps, backupId: string) {
	const [row] = await deps.db
		.select()
		.from(backups)
		.where(eq(backups.id, backupId));
	const obj = await deps.backups.get(`${row.prefix}manifest.json`);
	if (!obj) throw new Error("manifest missing");
	return JSON.parse(await (obj as R2ObjectBody).text()) as {
		tables: { name: string; rows: number; parts: unknown[] }[];
	};
}

describe("runBackup", () => {
	const deps = testDeps();

	beforeEach(async () => {
		await cleanBackups(deps);
		await deps.db.delete(settings).where(eq(settings.key, "storage"));
	});

	it("full run verifies, with manifest counts equal to SELECT COUNT(*)", async () => {
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p, { status: "delivered" });
		const id = `bk-full-${Date.now()}`;
		const r = await startBackupRun(
			deps,
			{ instanceId: id, trigger: "manual" },
			logger,
		);
		expect(r).toBe("started");
		const out = await runBackup(
			plain,
			() => deps,
			{ backupId: id, trigger: "manual" },
			id,
			logger,
		);
		expect(out.continued).toBe(false);
		expect(out.parts).toBeGreaterThan(0);

		const [row] = await deps.db
			.select()
			.from(backups)
			.where(eq(backups.id, id));
		expect(row.status).toBe("verified");
		expect(row.prefix).toMatch(/^d1\/\d{4}\/\d{2}\/\d{2}\//);

		const expected = await rowCounts(deps);
		const manifest = await readManifest(deps, id);
		expect(
			Object.fromEntries(manifest.tables.map((t) => [t.name, t.rows])),
		).toEqual(expected);
		// Review Focus 3: an empty table is listed with rows 0 and no parts.
		const empty = manifest.tables.find((t) => t.name === "test_deliveries");
		expect(empty).toMatchObject({ rows: 0, parts: [] });
		expect(expected.test_deliveries).toBe(0);
	});

	it("continuation resumes and matches a single uninterrupted run", async () => {
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p, { status: "delivered" });

		// Baseline: one uninterrupted run.
		const solo = `bk-solo-${Date.now()}`;
		await startBackupRun(deps, { instanceId: solo, trigger: "manual" }, logger);
		await runBackup(
			plain,
			() => deps,
			{ backupId: solo, trigger: "manual" },
			solo,
			logger,
		);
		const soloRows = await readManifest(deps, solo);

		// Split run with a tiny budget.
		const backup = recordingBackup();
		const splitDeps = testDeps({ backup });
		const base = `bk-split-${Date.now()}`;
		await startBackupRun(
			splitDeps,
			{ instanceId: base, trigger: "manual" },
			logger,
		);
		const first = await runBackup(
			plain,
			() => splitDeps,
			{ backupId: base, trigger: "manual" },
			base,
			logger,
			{ stepBudget: 6 },
		);
		expect(first.continued).toBe(true);
		const cont = backup.created.find((c) => c.id === `${base}-cont-1`);
		expect(cont).toBeDefined();
		const resume = (cont?.params as { resume?: unknown })?.resume;
		expect(resume).toMatchObject({ tableName: expect.any(String) });
		const tables = (cont?.params as { tables?: unknown })?.tables;
		expect(tables).toEqual((await listTables(deps.db)).map((t) => t.name));

		const [running] = await deps.db
			.select()
			.from(backups)
			.where(eq(backups.id, base));
		expect(running.status).toBe("running");

		const second = await runBackup(
			plain,
			() => splitDeps,
			{
				backupId: base,
				trigger: "manual",
				...(cont?.params as Pick<BackupParams, "resume" | "tables">),
			},
			`${base}-cont-1`,
			logger,
		);
		expect(second.continued).toBe(false);
		const [done] = await deps.db
			.select()
			.from(backups)
			.where(eq(backups.id, base));
		expect(done.status).toBe("verified");
		// The backups table itself grows between the two runs (each run
		// dumps its own row), so counts are compared without it.
		const counts = (m: { tables: { name: string; rows: number }[] }) =>
			Object.fromEntries(
				m.tables
					.filter((t) => t.name !== "backups")
					.map((t) => [t.name, t.rows]),
			);
		expect(counts(await readManifest(deps, base))).toEqual(
			counts(await readManifest(deps, solo)),
		);
		expect(soloRows.tables.length).toBeGreaterThan(0);
	});

	/** Runs the first instance with a tiny budget; returns the continuation params. */
	async function splitFirst(prefix: string) {
		const backup = recordingBackup();
		const splitDeps = testDeps({ backup });
		const base = `${prefix}-${Date.now()}`;
		await startBackupRun(
			splitDeps,
			{ instanceId: base, trigger: "manual" },
			logger,
		);
		const first = await runBackup(
			plain,
			() => splitDeps,
			{ backupId: base, trigger: "manual" },
			base,
			logger,
			{ stepBudget: 6 },
		);
		expect(first.continued).toBe(true);
		const cont = backup.created.find((c) => c.id === `${base}-cont-1`);
		return { base, splitDeps, params: cont?.params as BackupParams };
	}

	it("continuation keeps the original table list when a table is added between instances", async () => {
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p, { status: "delivered" });
		const { base, splitDeps, params } = await splitFirst("bk-added");
		// "aaa_…" sorts first: an index-based resume would shift by one.
		await deps.db.run(sql`CREATE TABLE aaa_added_mid_run (id TEXT PRIMARY KEY)`);
		await deps.db.run(sql`INSERT INTO aaa_added_mid_run VALUES ('x')`);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const second = await runBackup(
				plain,
				() => splitDeps,
				params,
				`${base}-cont-1`,
				createLogger({ LOG_LEVEL: "warn" }),
			);
			expect(second.continued).toBe(false);
			const msgs = warn.mock.calls.map((c) => JSON.parse(String(c[0])));
			expect(msgs).toContainEqual(
				expect.objectContaining({
					msg: "backup.tables_added",
					tables: ["aaa_added_mid_run"],
				}),
			);
		} finally {
			warn.mockRestore();
			await deps.db.run(sql`DROP TABLE aaa_added_mid_run`);
		}
		const [done] = await deps.db
			.select()
			.from(backups)
			.where(eq(backups.id, base));
		expect(done.status).toBe("verified");
		const manifest = await readManifest(deps, base);
		expect(manifest.tables.map((t) => t.name)).toEqual(params.tables);
		const counts = await rowCounts(deps);
		for (const t of manifest.tables) {
			if (t.name === "backups") continue;
			expect([t.name, t.rows]).toEqual([t.name, counts[t.name]]);
		}
	});

	it("continuation fails clearly when a table of the original list vanished", async () => {
		await deps.db.run(sql`CREATE TABLE zzz_vanishing (id TEXT PRIMARY KEY)`);
		let dropped = false;
		try {
			const { base, splitDeps, params } = await splitFirst("bk-vanish");
			await deps.db.run(sql`DROP TABLE zzz_vanishing`);
			dropped = true;
			await expect(
				runBackup(plain, () => splitDeps, params, `${base}-cont-1`, logger),
			).rejects.toThrow(/zzz_vanishing.*no longer exists/);
			const [row] = await deps.db
				.select()
				.from(backups)
				.where(eq(backups.id, base));
			expect(row.status).toBe("failed");
		} finally {
			if (!dropped) await deps.db.run(sql`DROP TABLE zzz_vanishing`);
		}
	});

	it("failure marks failed: an R2 put that throws leaves the error text", async () => {
		const id = `bk-fail-${Date.now()}`;
		await startBackupRun(deps, { instanceId: id, trigger: "manual" }, logger);
		const broken = testDeps({
			backups: faultyR2(deps.backups, [{ match: /put / }]),
		});
		await expect(
			runBackup(
				plain,
				() => broken,
				{ backupId: id, trigger: "manual" },
				id,
				logger,
			),
		).rejects.toThrow();
		const [row] = await deps.db
			.select()
			.from(backups)
			.where(eq(backups.id, id));
		expect(row.status).toBe("failed");
		expect(row.error).toContain("R2 error");
	});
});

describe("backup cron", () => {
	const scratch = testDeps();

	beforeEach(async () => {
		await cleanBackups(scratch);
		await scratch.db.delete(settings).where(eq(settings.key, "storage"));
	});

	it("cron disabled: backup_enabled false makes no create call and logs backup.disabled", async () => {
		const backup = recordingBackup();
		const deps = testDeps({ backup });
		await setStorage(deps, { backup_enabled: false });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await runScheduled(BACKUP_CRON, deps);
		const msgs = log.mock.calls.map((c) => JSON.parse(c[0] as string).msg);
		log.mockRestore();
		expect(backup.created).toEqual([]);
		expect(msgs).toContain("backup.disabled");
		const rows = await deps.db.select({ id: backups.id }).from(backups);
		expect(rows).toEqual([]);
	});

	it("cron duplicate: a second start returns duplicate and inserts no row (Review Focus 5)", async () => {
		const deps = testDeps({ backup: fakeBackup() });
		await cleanBackups(deps);
		const id = "backup-2026-10-16";
		expect(
			await startBackupRun(deps, { instanceId: id, trigger: "cron" }, logger),
		).toBe("started");
		expect(
			await startBackupRun(deps, { instanceId: id, trigger: "cron" }, logger),
		).toBe("duplicate");
		const rows = await deps.db.select({ id: backups.id }).from(backups);
		expect(rows.map((r) => r.id)).toEqual([id]);
	});

	it("a retried continue step still moves the row's instance_id when create says duplicate", async () => {
		const backup = recordingBackup();
		const deps = testDeps({ backup });
		await cleanBackups(deps);
		await startBackupRun(deps, { instanceId: "bk-c", trigger: "cron" }, logger);
		const cont = {
			instanceId: "bk-c-cont-1",
			trigger: "cron" as const,
			backupId: "bk-c",
			resume: { tableName: "backups", cursor: null, partNo: 1 },
		};
		// First attempt: create succeeded, then the step failed before the UPDATE landed.
		await backup.create({ id: cont.instanceId, params: {} });
		expect(await startBackupRun(deps, cont, logger)).toBe("duplicate");
		const [row] = await deps.db
			.select()
			.from(backups)
			.where(eq(backups.id, "bk-c"));
		expect(row.instanceId).toBe("bk-c-cont-1");
	});

	it("cron enabled starts one backup-<day> instance", async () => {
		const backup = recordingBackup();
		const deps = testDeps({ backup, now: () => Date.UTC(2026, 9, 16, 20) });
		await cleanBackups(deps);
		await runScheduled(BACKUP_CRON, deps);
		await runScheduled(BACKUP_CRON, deps);
		expect(backup.created.map((c) => c.id)).toEqual(["backup-2026-10-16"]);
		const rows = await deps.db.select({ id: backups.id }).from(backups);
		expect(rows.map((r) => r.id)).toEqual(["backup-2026-10-16"]);
	});
});

describe("backup liveness", () => {
	const deps = testDeps();

	beforeEach(() => cleanBackups(deps));

	it("isBackupRunning follows the workflow status; a lost instance fails the row", async () => {
		const live = testDeps({ backup: recordingBackup("running") });
		await cleanBackups(live);
		await startBackupRun(
			live,
			{ instanceId: "bk-live", trigger: "manual" },
			logger,
		);
		expect(await isBackupRunning(live)).toBe(true);

		const lost = testDeps({ backup: recordingBackup("missing") });
		await lost.db.insert(backups).values({
			id: "bk-lost",
			day: "2026-10-16",
			status: "running",
			prefix: "d1/2026/10/16/bk-lost/",
			instanceId: "bk-lost",
			trigger: "manual",
			startedAt: Date.now(),
		});
		expect(await isBackupRunning(lost)).toBe(false);
		const [row] = await lost.db
			.select()
			.from(backups)
			.where(eq(backups.id, "bk-lost"));
		expect(row).toMatchObject({ status: "failed", error: "instance lost" });
	});

	it("readBackupSummary reports enabled, last verified, last failed, and running", async () => {
		await setStorage(deps, { backup_enabled: true });
		const now = Date.now();
		await deps.db.insert(backups).values({
			id: "bk-sum-v",
			day: "2026-10-15",
			status: "verified",
			prefix: "d1/2026/10/15/bk-sum-v/",
			partCount: 2,
			rowCountsJson: JSON.stringify({ a: 3, b: 4 }),
			bytes: 100,
			instanceId: "bk-sum-v",
			trigger: "cron",
			startedAt: now - 2,
			finishedAt: now - 1,
			error: null,
		});
		await deps.db.insert(backups).values({
			id: "bk-sum-f",
			day: "2026-10-16",
			status: "failed",
			prefix: "d1/2026/10/16/bk-sum-f/",
			instanceId: "bk-sum-f",
			trigger: "cron",
			startedAt: now,
			error: "boom",
		});
		const summary = await readBackupSummary(deps);
		expect(summary.enabled).toBe(true);
		expect(summary.last_verified).toMatchObject({
			id: "bk-sum-v",
			bytes: 100,
			rows: 7,
		});
		expect(summary.last_failed).toMatchObject({
			id: "bk-sum-f",
			error: "boom",
		});
		expect(summary.running).toBeNull();
	});
});

describe("BackupWorkflow end to end", () => {
	const deps = testDeps();

	it("the instance completes and the row is verified", async () => {
		await cleanBackups(deps);
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p, { status: "delivered" });
		const id = `backup-test-${Date.now()}`;
		const instance = await introspectWorkflowInstance(env.BACKUP, id);
		try {
			const live = testDeps({ backup: env.BACKUP as unknown as Workflow });
			expect(
				await startBackupRun(
					live,
					{ instanceId: id, trigger: "manual" },
					logger,
				),
			).toBe("started");
			await instance.waitForStatus("complete");
		} finally {
			await instance.dispose();
		}
		const [row] = await deps.db
			.select()
			.from(backups)
			.where(eq(backups.id, id));
		expect(row.status).toBe("verified");
	});
});
