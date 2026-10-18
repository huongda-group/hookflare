import type { QueryClient } from "@tanstack/react-query";
import { qk } from "./keys";

/**
 * Refresh every view a replay or destination operation can change: the event
 * and failure lists, the overview aggregates, and the destination stats
 * (spec §9.2). Prefix keys so current and future list shapes invalidate.
 */
export async function invalidateDeliveryViews(
	qc: QueryClient,
): Promise<void> {
	await Promise.all([
		qc.invalidateQueries({ queryKey: qk.events.all }),
		qc.invalidateQueries({ queryKey: qk.failures.all }),
		qc.invalidateQueries({ queryKey: ["overview"] }),
		qc.invalidateQueries({ queryKey: ["destinations", "stats"] }),
	]);
}
