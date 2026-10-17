import type { BackupSummary } from "@hookflare/shared";
import { desc, eq } from "drizzle-orm";
import type { Deps } from "../deps";
import { ARCHIVE_RUNNING } from "./archive-run";
import { backups } from "./db/schema";
import type { Logger } from "./log";
import { readSetting, STORAGE_SETTING } from "./settings";

export type BackupParams = {
	backupId: string;
	trigger: "cron" | "manual";
	/**
	 * Table names the first instance listed. A continuation backs up exactly
	 * these, so a migration between instances cannot shift the resume point.
	 */
	tables?: string[];
	/** Where a continuation picks up: the table by name, not by index. */
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

/**
 * Creates the backup Workflow instance, then records the `backups` row
 * (`running`, prefix `d1/YYYY/MM/DD/<id>/`). A continuation passes its
 * existing `backupId` plus `resume`: only the instance ID on the row moves.
 * A duplicate instance ID means this backup already started.
 */
export async function startBackupRun(
	deps: Deps,
	opts: StartBackupOpts,
	logger: Logger,
): Promise<"started" | "duplicate"> {
	const backupId = opts.backupId ?? opts.instanceId;
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
			logger.info("backup.already_started", { instance_id: opts.instanceId });
			return "duplicate";
		}
		throw err;
	}
	const now = deps.now();
	if (opts.backupId) {
		await deps.db
			.update(backups)
			.set({ instanceId: opts.instanceId })
			.where(eq(backups.id, opts.backupId));
	} else {
		const day = new Date(now).toISOString().slice(0, 10);
		await deps.db.insert(backups).values({
			id: backupId,
			day,
			status: "running",
			prefix: `d1/${day.replaceAll("-", "/")}/${backupId}/`,
			instanceId: opts.instanceId,
			trigger: opts.trigger,
			startedAt: now,
		});
	}
	logger.info("backup.started", {
		instance_id: opts.instanceId,
		backup_id: backupId,
		trigger: opts.trigger,
	});
	return "started";
}

/**
 * True while any `running` row's instance is still live (`ARCHIVE_RUNNING`
 * or `unknown`: adopting a live instance's backup would run it twice). A
 * row whose instance is gone from Workflows retention failed: it is marked
 * `failed` with `instance lost` so the next cron starts over.
 */
export async function isBackupRunning(deps: Deps): Promise<boolean> {
	const rows = await deps.db
		.select()
		.from(backups)
		.where(eq(backups.status, "running"));
	for (const row of rows) {
		try {
			const { status } = await (await deps.backup.get(row.instanceId)).status();
			if (
				status === "unknown" ||
				(ARCHIVE_RUNNING as readonly string[]).includes(status)
			)
				return true;
		} catch (err) {
			if (/not.?found/i.test(String(err))) {
				await deps.db
					.update(backups)
					.set({ status: "failed", error: "instance lost" })
					.where(eq(backups.id, row.id));
			} else {
				return true;
			}
		}
	}
	return false;
}

/** The admin Overview's backup card: newest verified, failed, and running rows. */
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
