import { DEFAULT_ALERT_RULES } from "@hookflare/shared";
import { eq, sql } from "drizzle-orm";
import {
	alertChannels,
	alertNotifications,
	alerts,
	settings,
} from "../../src/core/db/schema";
import type { Deps } from "../../src/deps";

export const RULES = DEFAULT_ALERT_RULES;

/** Alerts are global state; every alerts test starts from an empty set. */
export async function resetAlerts(deps: Deps) {
	await deps.db.delete(alertNotifications);
	await deps.db.delete(alerts);
	await deps.db.delete(alertChannels);
	await deps.db.delete(settings).where(eq(settings.key, "alerts.dead_cursor"));
	// Other test files leave destinations behind; neutralise their counters.
	await deps.db.run(sql`UPDATE destinations SET consecutive_failures = 0`);
	await deps.db.run(
		sql`UPDATE deliveries SET status = 'delivered' WHERE status IN ('pending', 'queued')`,
	);
}
