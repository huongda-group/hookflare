import { startArchiveRun } from "../core/archive-run";
import { isBackupRunning, startBackupRun } from "../core/backup-run";
import { beat, type JobName } from "../core/heartbeat";
import { createLogger, type Logger } from "../core/log";
import { readSetting, STORAGE_SETTING } from "../core/settings";
import type { Deps } from "../deps";
import { runAlerts } from "./alerts/job";
import { dayOf } from "./archive/keys";
import { reconcile } from "./reconcile";
import { rollup } from "./rollup";

export const RECONCILE_CRON = "* * * * *";
export const ROLLUP_CRON = "*/5 * * * *";
export const ARCHIVE_CRON = "0 3 * * *";
export const BACKUP_CRON = "0 20 * * *";

/** A heartbeat must never fail the job: beat throws, this logs. */
async function beatSafe(
	deps: Deps,
	logger: Logger,
	job: JobName,
): Promise<void> {
	try {
		await beat(deps.db, job, deps.now());
	} catch (err) {
		logger.error("heartbeat.failed", { job, error: String(err) });
	}
}

/** Dispatches on controller.cron. */
export async function runScheduled(cron: string, deps: Deps): Promise<void> {
	const logger = createLogger(deps.env, { cron });
	if (cron === RECONCILE_CRON) {
		try {
			logger.info("reconcile.run", await reconcile(deps));
			await beatSafe(deps, logger, "reconcile");
		} catch (err) {
			// Idempotent: the next minute starts over.
			logger.error("reconcile.failed", { error: String(err) });
		}
		try {
			const r = await runAlerts(deps, logger);
			logger.info("alerts.run", r);
			await beatSafe(deps, logger, "alerts");
		} catch (err) {
			logger.error("alerts.failed", { error: String(err) });
		}
		return;
	}
	if (cron === ROLLUP_CRON) {
		try {
			logger.info("rollup.run", await rollup(deps, logger));
			await beatSafe(deps, logger, "rollup");
		} catch (err) {
			// Idempotent: the next run recomputes the same hours (spec M4-5).
			logger.error("rollup.failed", { error: String(err) });
		}
		return;
	}
	if (cron === ARCHIVE_CRON) {
		try {
			await startArchiveRun(
				deps,
				`archive-${dayOf(deps.now())}`,
				"cron",
				logger,
			);
		} catch (err) {
			logger.error("archive.start_failed", { error: String(err) });
		}
		return;
	}
	if (cron === BACKUP_CRON) {
		const { value: storage } = await readSetting(deps.db, STORAGE_SETTING);
		if (!storage.backup_enabled) {
			logger.info("backup.disabled", {});
			await beatSafe(deps, logger, "backup");
			return;
		}
		try {
			// A previous (or manual) backup may still be going: a second
			// one would double the D1 read load for no gain.
			if (await isBackupRunning(deps)) {
				logger.info("backup.skipped_running", {});
				await beatSafe(deps, logger, "backup");
				return;
			}
			await startBackupRun(
				deps,
				{ instanceId: `backup-${dayOf(deps.now())}`, trigger: "cron" },
				logger,
			);
			await beatSafe(deps, logger, "backup");
		} catch (err) {
			logger.error("backup.start_failed", { error: String(err) });
		}
		return;
	}
	logger.warn("scheduled.unknown_cron");
}
