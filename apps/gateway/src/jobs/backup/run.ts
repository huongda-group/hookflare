import { eq } from "drizzle-orm";
import { type BackupParams, startBackupRun } from "../../core/backup-run";
import { backups } from "../../core/db/schema";
import type { Logger } from "../../core/log";
import { readSetting, STORAGE_SETTING } from "../../core/settings";
import type { StepFn } from "../../core/workflow";
import type { Deps } from "../../deps";
import { dumpPage, type PartMeta, partKey } from "./dump";
import { writeManifest } from "./manifest";
import { expireBackups } from "./retention";
import { listTables, type TableInfo } from "./tables";
import { verifyBackup } from "./verify";

export type BackupLimits = { stepBudget: number };
export const DEFAULT_BACKUP_LIMITS: BackupLimits = { stepBudget: 900 };
const FINAL_STEPS = 3;

function sidecarKey(prefix: string, table: string, partNo: number): string {
	return `${prefix}parts/${table}-${String(partNo).padStart(4, "0")}.json`;
}

function continuationOf(instanceId: string): { base: string; n: number } {
	const m = /-cont-(\d+)$/.exec(instanceId);
	return m
		? { base: instanceId.slice(0, m.index), n: Number(m[1]) + 1 }
		: { base: instanceId, n: 1 };
}

export async function dumpPart(
	d: Pick<Deps, "db" | "backups">,
	table: TableInfo,
	prefix: string,
	partNo: number,
	cursor: string | number | null,
): Promise<{ part: PartMeta | null; next: string | number | null }> {
	const r = await dumpPage(d, table, prefix, partNo, cursor);
	if (r.part) {
		await d.backups.put(
			sidecarKey(prefix, table.name, partNo),
			new TextEncoder().encode(JSON.stringify(r.part)),
		);
	} else {
		await d.backups.delete([
			sidecarKey(prefix, table.name, partNo),
			partKey(prefix, table.name, partNo),
		]);
	}
	return r;
}

async function readPartSidecars(
	d: Pick<Deps, "backups">,
	prefix: string,
): Promise<PartMeta[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await d.backups.list({ prefix: `${prefix}parts/`, cursor });
		keys.push(...page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	keys.sort();
	const parts: PartMeta[] = [];
	for (const key of keys) {
		const obj = await d.backups.get(key);
		if (!obj) throw new Error(`part sidecar ${key}: object missing`);
		parts.push(JSON.parse(await obj.text()) as PartMeta);
	}
	return parts;
}

function pinTables(
	live: TableInfo[],
	pinned: string[] | undefined,
): { list: TableInfo[]; added: string[] } {
	if (!pinned) return { list: live, added: [] };
	const byName = new Map(live.map((t) => [t.name, t]));
	const list = pinned.map((name) => {
		const t = byName.get(name);
		if (!t)
			throw new Error(
				`table ${name} no longer exists: it was dropped while the backup was running`,
			);
		return t;
	});
	const keep = new Set(pinned);
	return {
		list,
		added: live.filter((t) => !keep.has(t.name)).map((t) => t.name),
	};
}

export async function runBackup(
	step: StepFn,
	deps: () => Deps,
	params: BackupParams,
	instanceId: string,
	logger: Logger,
	limits: BackupLimits = DEFAULT_BACKUP_LIMITS,
): Promise<{ parts: number; continued: boolean }> {
	let used = 0;
	const at = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
		used += 1;
		return step(name, fn);
	};
	try {
		const start = await at("start", async () => {
			const d = deps();
			const [row] = await d.db
				.select()
				.from(backups)
				.where(eq(backups.id, params.backupId));
			if (!row) throw new Error(`backup ${params.backupId} not found`);
			const pinned = pinTables(await listTables(d.db), params.tables);
			if (pinned.added.length > 0)
				logger.warn("backup.tables_added", {
					backup_id: params.backupId,
					tables: pinned.added,
				});
			return {
				tables: pinned.list,
				prefix: row.prefix,
				startedAt: row.startedAt,
			};
		});
		const tables = start.tables;
		const names = tables.map((t) => t.name);

		let parts = 0;
		let tableIndex = 0;
		if (params.resume) {
			tableIndex = names.indexOf(params.resume.tableName);
			if (tableIndex < 0)
				throw new Error(
					`resume table ${params.resume.tableName} is not in the backup's table list`,
				);
		}
		for (; tableIndex < tables.length; tableIndex++) {
			const table = tables[tableIndex];
			const resumed = table.name === params.resume?.tableName;
			let cursor: string | number | null =
				resumed && params.resume ? params.resume.cursor : null;
			let partNo = resumed && params.resume ? params.resume.partNo : 1;
			for (;;) {
				const { part, next } = await at(`dump:${table.name}:${partNo}`, () =>
					dumpPart(deps(), table, start.prefix, partNo, cursor),
				);
				if (part) parts += 1;
				const following = tables[tableIndex + 1];
				const resume: BackupParams["resume"] =
					next !== null
						? { tableName: table.name, cursor: next, partNo: partNo + 1 }
						: following
							? { tableName: following.name, cursor: null, partNo: 1 }
							: undefined;
				if (resume && used >= limits.stepBudget - FINAL_STEPS) {
					const { base, n } = continuationOf(instanceId);
					await at("continue", () =>
						startBackupRun(
							deps(),
							{
								instanceId: `${base}-cont-${n}`,
								trigger: params.trigger,
								backupId: params.backupId,
								tables: names,
								resume,
							},
							logger,
						),
					);
					return { parts, continued: true };
				}
				if (next === null) break;
				cursor = next;
				partNo += 1;
			}
		}

		await at("manifest", async () => {
			const d = deps();
			await writeManifest(
				d,
				params.backupId,
				tables,
				await readPartSidecars(d, start.prefix),
				start.startedAt,
			);
		});
		const v = await at("verify", () => verifyBackup(deps(), params.backupId));
		if (!v.ok) throw new Error(v.error);
		await at("retention", async () => {
			const d = deps();
			const { value: storage } = await readSetting(d.db, STORAGE_SETTING);
			await expireBackups(d, storage, d.now());
		});
		return { parts, continued: false };
	} catch (err) {
		try {
			await at("fail", () =>
				deps()
					.db.update(backups)
					.set({ status: "failed", error: String(err) })
					.where(eq(backups.id, params.backupId)),
			);
		} catch {}
		throw err;
	}
}
