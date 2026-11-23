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
	newBackupRow,
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
import { faultyDeps, faultyR2 } from "../helpers/faults";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const logger = createLogger({ LOG_LEVEL: "error" });
const plain: StepFn = (_name, fn) => fn();

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

function bucketWith(
	base: Deps,
	over: (target: R2Bucket) => Partial<Record<keyof R2Bucket, unknown>>,
): Deps {
	return {
		...base,
		backups: new Proxy(base.backups, {
			get(target, prop) {
				const o = over(target) as Record<string | symbol, unknown>;
				if (prop in o) return o[prop];
				const v = Reflect.get(target, prop);
				return typeof v === "function" ? v.bind(target) : v;
			},
		}),
	};
}

async function rowOf(deps: Deps, id: string) {
	const [row] = await deps.db.select().from(backups).where(eq(backups.id, id));
	return row;
}

async function createBlobPages() {
	const d = testDeps();
	await d.db.run(
		sql`CREATE TABLE aaa_blob_pages (id INTEGER PRIMARY KEY, data BLOB)`,
	);
	await d.db.run(sql`INSERT INTO aaa_blob_pages (id, data)
		WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 251)
		SELECT n, X'00' FROM c`);
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
		const empty = manifest.tables.find((t) => t.name === "test_deliveries");
		expect(empty).toMatchObject({ rows: 0, parts: [] });
		expect(expected.test_deliveries).toBe(0);
	});

	it("continuation resumes and matches a single uninterrupted run", async () => {
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p, { status: "delivered" });

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
		await deps.db.run(
			sql`CREATE TABLE aaa_added_mid_run (id TEXT PRIMARY KEY)`,
		);
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

	it("a continuation that runs out of budget mid-table chains -cont-2 and resumes at the next page", async () => {
		await createBlobPages();
		try {
			const backup = recordingBackup();
			const d = testDeps({ backup });
			const base = `bk-chain-${Date.now()}`;
			await startBackupRun(d, { instanceId: base, trigger: "manual" }, logger);
			const first = await runBackup(
				plain,
				() => d,
				{ backupId: base, trigger: "manual" },
				base,
				logger,
				{ stepBudget: 5 },
			);
			expect(first.continued).toBe(true);
			const cont1 = backup.created.find((c) => c.id === `${base}-cont-1`)
				?.params as BackupParams;
			expect(cont1.resume).toEqual({
				tableName: "aaa_blob_pages",
				cursor: 250,
				partNo: 2,
			});

			const second = await runBackup(
				plain,
				() => d,
				cont1,
				`${base}-cont-1`,
				logger,
				{ stepBudget: 5 },
			);
			expect(second).toEqual({ parts: 1, continued: true });
			const cont2 = backup.created.find((c) => c.id === `${base}-cont-2`)
				?.params as BackupParams;
			const names = cont1.tables as string[];
			expect(cont2.resume).toEqual({
				tableName: names[names.indexOf("aaa_blob_pages") + 1],
				cursor: null,
				partNo: 1,
			});
			expect((await rowOf(d, base)).instanceId).toBe(`${base}-cont-2`);

			const third = await runBackup(
				plain,
				() => d,
				cont2,
				`${base}-cont-2`,
				logger,
			);
			expect(third.continued).toBe(false);
			expect((await rowOf(d, base)).status).toBe("verified");
			const manifest = await readManifest(d, base);
			expect(
				manifest.tables.find((t) => t.name === "aaa_blob_pages"),
			).toMatchObject({ rows: 251, parts: [{ rows: 250 }, { rows: 1 }] });
		} finally {
			await deps.db.run(sql`DROP TABLE aaa_blob_pages`);
		}
	});

	it("one run pages through a multi-part table, and the manifest lists every sidecar even when R2 pages the listing", async () => {
		await createBlobPages();
		try {
			const id = `bk-paged-${Date.now()}`;
			await startBackupRun(deps, { instanceId: id, trigger: "manual" }, logger);
			const paged = bucketWith(deps, (t) => ({
				list: (o: R2ListOptions) => t.list({ ...o, limit: 1 }),
			}));
			const out = await runBackup(
				plain,
				() => paged,
				{ backupId: id, trigger: "manual" },
				id,
				logger,
			);
			expect(out.continued).toBe(false);
			expect((await rowOf(deps, id)).status).toBe("verified");
			const manifest = await readManifest(deps, id);
			expect(manifest.tables.flatMap((t) => t.parts)).toHaveLength(out.parts);
			expect(
				manifest.tables.find((t) => t.name === "aaa_blob_pages"),
			).toMatchObject({ rows: 251, parts: [{ rows: 250 }, { rows: 1 }] });
		} finally {
			await deps.db.run(sql`DROP TABLE aaa_blob_pages`);
		}
	});

	it("a part sidecar that disappears before the manifest step fails the backup", async () => {
		const id = `bk-sidecar-${Date.now()}`;
		await startBackupRun(deps, { instanceId: id, trigger: "manual" }, logger);
		const lossy = bucketWith(deps, (t) => ({
			get: (key: string) => (key.includes("/parts/") ? null : t.get(key)),
		}));
		await expect(
			runBackup(
				plain,
				() => lossy,
				{ backupId: id, trigger: "manual" },
				id,
				logger,
			),
		).rejects.toThrow(/part sidecar .*parts\/.*: object missing/);
		expect(await rowOf(deps, id)).toMatchObject({ status: "failed" });
		expect((await rowOf(deps, id)).error).toMatch(/object missing/);
	});

	it("a backup ID without a row fails at the start step and creates no row", async () => {
		await expect(
			runBackup(
				plain,
				() => deps,
				{ backupId: "bk-ghost", trigger: "manual" },
				"bk-ghost",
				logger,
			),
		).rejects.toThrow("backup bk-ghost not found");
		expect(await deps.db.select().from(backups)).toEqual([]);
	});

	it("a resume naming a table outside the pinned list fails the backup", async () => {
		const id = `bk-badresume-${Date.now()}`;
		await startBackupRun(deps, { instanceId: id, trigger: "manual" }, logger);
		await expect(
			runBackup(
				plain,
				() => deps,
				{
					backupId: id,
					trigger: "manual",
					resume: { tableName: "no_such_table", cursor: null, partNo: 1 },
				},
				`${id}-cont-1`,
				logger,
			),
		).rejects.toThrow(
			"resume table no_such_table is not in the backup's table list",
		);
		expect((await rowOf(deps, id)).status).toBe("failed");
	});

	it("a failed verify fails the run and skips retention", async () => {
		const id = `bk-badverify-${Date.now()}`;
		await startBackupRun(deps, { instanceId: id, trigger: "manual" }, logger);
		const blind = bucketWith(deps, (t) => ({
			head: (key: string) =>
				key.endsWith("manifest.json") ? null : t.head(key),
		}));
		const steps: string[] = [];
		const tracking: StepFn = (name, fn) => {
			steps.push(name);
			return fn();
		};
		await expect(
			runBackup(
				tracking,
				() => blind,
				{ backupId: id, trigger: "manual" },
				id,
				logger,
			),
		).rejects.toThrow("manifest: object missing");
		expect(steps).toContain("verify");
		expect(steps).not.toContain("retention");
		expect(await rowOf(deps, id)).toMatchObject({
			status: "failed",
			error: "Error: manifest: object missing",
		});
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

	it("cron settings read failure: a D1 error is logged as backup.start_failed, not thrown", async () => {
		const backup = recordingBackup();
		const base = testDeps({ backup });
		const db = new Proxy(base.db, {
			get(target, prop, receiver) {
				if (prop === "select") {
					return () => {
						throw new Error("D1 unavailable");
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});
		const deps = { ...base, db };
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(runScheduled(BACKUP_CRON, deps)).resolves.toBeUndefined();
		const msgs = err.mock.calls.map((c) => JSON.parse(c[0] as string).msg);
		err.mockRestore();
		expect(msgs).toContain("backup.start_failed");
		expect(backup.created).toEqual([]);
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

	it("a cron start racing a running manual backup creates no workflow instance", async () => {
		const backup = recordingBackup("running");
		const deps = testDeps({ backup });
		await cleanBackups(deps);
		await deps.db
			.insert(backups)
			.values(newBackupRow(deps.now(), "manual-1", "manual"));
		expect(
			await startBackupRun(
				deps,
				{ instanceId: "backup-2026-10-17", trigger: "cron" },
				logger,
			),
		).toBe("duplicate");
		expect(backup.created).toEqual([]);
	});

	it("a failed workflow create marks the new row failed", async () => {
		const deps = testDeps({
			backup: {
				async create() {
					throw new Error("workflows unavailable");
				},
			} as unknown as Workflow,
		});
		await cleanBackups(deps);
		await expect(
			startBackupRun(deps, { instanceId: "bk-f", trigger: "cron" }, logger),
		).rejects.toThrow("workflows unavailable");
		const [row] = await deps.db
			.select()
			.from(backups)
			.where(eq(backups.id, "bk-f"));
		expect(row.status).toBe("failed");
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
		await backup.create({ id: cont.instanceId, params: {} });
		expect(await startBackupRun(deps, cont, logger)).toBe("duplicate");
		const [row] = await deps.db
			.select()
			.from(backups)
			.where(eq(backups.id, "bk-c"));
		expect(row.instanceId).toBe("bk-c-cont-1");
	});

	it("a D1 error other than a unique violation on the row insert is thrown", async () => {
		const backup = recordingBackup();
		const deps = faultyDeps(testDeps({ backup }), {
			d1: [{ match: /insert into "backups"/i }],
		});
		await expect(
			startBackupRun(deps, { instanceId: "bk-d1", trigger: "cron" }, logger),
		).rejects.toThrow(/Failed query: insert into "backups"/);
		expect(backup.created).toEqual([]);
		expect(await deps.db.select().from(backups)).toEqual([]);
	});

	it("a first start whose instance already exists returns duplicate and keeps the running row", async () => {
		const backup = recordingBackup();
		const deps = testDeps({ backup });
		await cleanBackups(deps);
		await backup.create({ id: "bk-pre", params: {} });
		expect(
			await startBackupRun(
				deps,
				{ instanceId: "bk-pre", trigger: "cron" },
				logger,
			),
		).toBe("duplicate");
		expect(await rowOf(deps, "bk-pre")).toMatchObject({
			status: "running",
			instanceId: "bk-pre",
		});
	});

	it("a continuation whose create fails throws and leaves the row running on its old instance", async () => {
		const good = recordingBackup();
		const deps = testDeps({ backup: good });
		await cleanBackups(deps);
		await startBackupRun(deps, { instanceId: "bk-k", trigger: "cron" }, logger);
		const broken = testDeps({
			backup: {
				async create() {
					throw new Error("workflows unavailable");
				},
			} as unknown as Workflow,
		});
		await expect(
			startBackupRun(
				broken,
				{
					instanceId: "bk-k-cont-1",
					trigger: "cron",
					backupId: "bk-k",
					resume: { tableName: "backups", cursor: null, partNo: 1 },
				},
				logger,
			),
		).rejects.toThrow("workflows unavailable");
		expect(await rowOf(deps, "bk-k")).toMatchObject({
			status: "running",
			instanceId: "bk-k",
			error: null,
		});
	});

	it("cron skips (and logs) while a backup is still running", async () => {
		const backup = recordingBackup("running");
		const deps = testDeps({ backup, now: () => Date.UTC(2026, 9, 17, 20) });
		await cleanBackups(deps);
		await startBackupRun(
			deps,
			{ instanceId: "backup-2026-10-16", trigger: "cron" },
			logger,
		);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await runScheduled(BACKUP_CRON, deps);
		const msgs = log.mock.calls.map((c) => JSON.parse(c[0] as string).msg);
		log.mockRestore();
		expect(msgs).toContain("backup.skipped_running");
		expect(backup.created.map((c) => c.id)).toEqual(["backup-2026-10-16"]);
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
		await cleanBackups(lost);
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

	it.each(["errored", "terminated", "complete"])(
		"isBackupRunning fails a running row whose instance is %s",
		async (status) => {
			const dead = testDeps({ backup: recordingBackup(status) });
			await cleanBackups(dead);
			await dead.db.insert(backups).values({
				id: `bk-${status}`,
				day: "2026-10-16",
				status: "running",
				prefix: `d1/2026/10/16/bk-${status}/`,
				instanceId: `bk-${status}`,
				trigger: "manual",
				startedAt: Date.now(),
			});
			expect(await isBackupRunning(dead)).toBe(false);
			const [row] = await dead.db
				.select()
				.from(backups)
				.where(eq(backups.id, `bk-${status}`));
			expect(row).toMatchObject({
				status: "failed",
				error: `instance ${status}`,
			});
		},
	);

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

	it("isBackupRunning treats a Workflows error other than not-found as running", async () => {
		const flaky = testDeps({
			backup: {
				async get() {
					throw new Error("workflows: internal error");
				},
			} as unknown as Workflow,
		});
		await flaky.db
			.insert(backups)
			.values(newBackupRow(Date.now(), "bk-flaky", "cron"));
		expect(await isBackupRunning(flaky)).toBe(true);
		expect(await rowOf(flaky, "bk-flaky")).toMatchObject({
			status: "running",
			error: null,
		});
	});

	it("readBackupSummary falls back to started_at and reports the running backup", async () => {
		const now = Date.now();
		expect((await readBackupSummary(deps)).last_verified).toBeNull();
		await deps.db.insert(backups).values({
			...newBackupRow(now - 10, "bk-sum-old", "cron"),
			status: "verified",
			rowCountsJson: JSON.stringify({ a: 1 }),
		});
		await deps.db.insert(backups).values({
			...newBackupRow(now, "bk-sum-run", "manual"),
			instanceId: "bk-sum-run-cont-1",
		});
		const summary = await readBackupSummary(deps);
		expect(summary.last_verified).toEqual({
			id: "bk-sum-old",
			started_at: now - 10,
			finished_at: now - 10,
			bytes: 0,
			rows: 1,
		});
		expect(summary.last_failed).toBeNull();
		expect(summary.running).toEqual({
			id: "bk-sum-run",
			instance_id: "bk-sum-run-cont-1",
			started_at: now,
		});
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
