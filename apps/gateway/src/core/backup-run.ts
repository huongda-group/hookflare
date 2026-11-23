import type { BackupSummary } from "@hookflare/shared";
import { and, desc, eq } from "drizzle-orm";
import type { Deps } from "../deps";
import { ARCHIVE_RUNNING } from "./archive-run";
import { isUniqueViolation } from "./db/errors";
import { backups } from "./db/schema";
import type { Logger } from "./log";
import { readSetting, STORAGE_SETTING } from "./settings";

export type BackupParams = {
	backupId: string;
	trigger: "cron" | "manual";
	tables?: string[];
	resume?: {
		tableName: string;
		cursor: string | number | null;
		partNo: number;
	};
};

export type StartBackupOpts = {
	instanceId: string;
	trigger: BackupParams["trigger"];
	backupId?: string;
	tables?: BackupParams["tables"];
	resume?: BackupParams["resume"];
};

export function newBackupRow(
	now: number,
	backupId: string,
	trigger: BackupParams["trigger"],
): typeof backups.$inferInsert {
	const day = new Date(now).toISOString().slice(0, 10);
	return {
		id: backupId,
		day,
		status: "running",
		prefix: `d1/${day.replaceAll("-", "/")}/${backupId}/`,
		instanceId: backupId,
		trigger,
		startedAt: now,
	};
}

async function moveInstance(
	deps: Deps,
	backupId: string,
	instanceId: string,
): Promise<void> {
	await deps.db
		.update(backups)
		.set({ instanceId })
		.where(eq(backups.id, backupId));
}

export async function startBackupRun(
	deps: Deps,
	opts: StartBackupOpts,
	logger: Logger,
): Promise<"started" | "duplicate"> {
	const backupId = opts.backupId ?? opts.instanceId;
	if (!opts.backupId) {
		try {
			await deps.db
				.insert(backups)
				.values(newBackupRow(deps.now(), backupId, opts.trigger));
		} catch (err) {
			if (!isUniqueViolation(err)) throw err;
			logger.info("backup.already_started", { instance_id: opts.instanceId });
			return "duplicate";
		}
	}
	try {
		await deps.backup.create({
			id: opts.instanceId,
			params: {
				backupId,
				trigger: opts.trigger,
				...(opts.tables ? { tables: opts.tables } : {}),
				...(opts.resume ? { resume: opts.resume } : {}),
			},
		});
	} catch (err) {
		if (/already.?exists|duplicate/i.test(String(err))) {
			if (opts.backupId)
				await moveInstance(deps, opts.backupId, opts.instanceId);
			logger.info("backup.already_started", { instance_id: opts.instanceId });
			return "duplicate";
		}
		if (!opts.backupId)
			await deps.db
				.update(backups)
				.set({
					status: "failed",
					error: `start failed: ${String(err)}`,
					finishedAt: deps.now(),
				})
				.where(eq(backups.id, backupId));
		throw err;
	}
	if (opts.backupId) await moveInstance(deps, opts.backupId, opts.instanceId);
	logger.info("backup.started", {
		instance_id: opts.instanceId,
		backup_id: backupId,
		trigger: opts.trigger,
	});
	return "started";
}

export async function isBackupRunning(deps: Deps): Promise<boolean> {
	const rows = await deps.db
		.select()
		.from(backups)
		.where(eq(backups.status, "running"));
	for (const row of rows) {
		let status: string;
		try {
			({ status } = await (await deps.backup.get(row.instanceId)).status());
		} catch (err) {
			if (!/not.?found/i.test(String(err))) return true;
			await failStale(deps, row, "instance lost");
			continue;
		}
		if (
			status === "unknown" ||
			(ARCHIVE_RUNNING as readonly string[]).includes(status)
		)
			return true;
		await failStale(deps, row, `instance ${status}`);
	}
	return false;
}

async function failStale(
	deps: Deps,
	row: { id: string; instanceId: string },
	error: string,
): Promise<void> {
	await deps.db
		.update(backups)
		.set({ status: "failed", error })
		.where(
			and(
				eq(backups.id, row.id),
				eq(backups.status, "running"),
				eq(backups.instanceId, row.instanceId),
			),
		);
}

export async function readBackupSummary(deps: Deps): Promise<BackupSummary> {
	const { value: storage } = await readSetting(deps.db, STORAGE_SETTING);
	const rows = await deps.db
		.select()
		.from(backups)
		.orderBy(desc(backups.startedAt));
	const verified = rows.find((r) => r.status === "verified");
	const failed = rows.find((r) => r.status === "failed");
	const running = rows.find((r) => r.status === "running");
	return {
		enabled: storage.backup_enabled,
		last_verified: verified
			? {
					id: verified.id,
					started_at: verified.startedAt,
					finished_at: verified.finishedAt ?? verified.startedAt,
					bytes: verified.bytes,
					rows: Object.values(
						JSON.parse(verified.rowCountsJson) as Record<string, number>,
					).reduce((s, n) => s + n, 0),
				}
			: null,
		last_failed: failed
			? { id: failed.id, started_at: failed.startedAt, error: failed.error }
			: null,
		running: running
			? {
					id: running.id,
					instance_id: running.instanceId,
					started_at: running.startedAt,
				}
			: null,
	};
}
