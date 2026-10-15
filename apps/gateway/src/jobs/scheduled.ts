import { createLogger } from "../core/log";
import type { Deps } from "../deps";
import { reconcile } from "./reconcile";

export const RECONCILE_CRON = "* * * * *";

/** Dispatches on controller.cron; M5 adds alerts, rollup, and archive crons. */
export async function runScheduled(cron: string, deps: Deps): Promise<void> {
	const logger = createLogger(deps.env, { cron });
	if (cron !== RECONCILE_CRON) {
		logger.warn("scheduled.unknown_cron");
		return;
	}
	try {
		logger.info("reconcile.run", await reconcile(deps));
	} catch (err) {
		// Idempotent: the next minute starts over.
		logger.error("reconcile.failed", { error: String(err) });
	}
}
