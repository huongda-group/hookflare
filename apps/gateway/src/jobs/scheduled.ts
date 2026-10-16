import { createLogger } from "../core/log";
import type { Deps } from "../deps";
import { reconcile } from "./reconcile";
import { rollup } from "./rollup";

export const RECONCILE_CRON = "* * * * *";
export const ROLLUP_CRON = "*/5 * * * *";

/** Dispatches on controller.cron; M5 adds the alerts and archive crons. */
export async function runScheduled(cron: string, deps: Deps): Promise<void> {
	const logger = createLogger(deps.env, { cron });
	if (cron === RECONCILE_CRON) {
		try {
			logger.info("reconcile.run", await reconcile(deps));
		} catch (err) {
			// Idempotent: the next minute starts over.
			logger.error("reconcile.failed", { error: String(err) });
		}
		return;
	}
	if (cron === ROLLUP_CRON) {
		try {
			logger.info("rollup.run", await rollup(deps, logger));
		} catch (err) {
			// Idempotent: the next run recomputes the same hours (spec M4-5).
			logger.error("rollup.failed", { error: String(err) });
		}
		return;
	}
	logger.warn("scheduled.unknown_cron");
}
