import type { QueryClient } from "@tanstack/react-query";
import { matchesProjectScope } from "./invalidate-endpoint-views";
import { qk } from "./keys";

/**
 * Refresh every view a replay or destination operation can change: the event
 * and failure lists, the overview aggregates, and the destination stats
 * (spec §9.2). Prefix keys so current and future list shapes invalidate.
 */
export async function invalidateDeliveryViews(
	qc: QueryClient,
	projectId?: string,
): Promise<void> {
	const predicate = projectId
		? ({ queryKey }: { queryKey: readonly unknown[] }) => {
				const scope = queryKey[0] === "overview" ? queryKey[1] : queryKey[2];
				return matchesProjectScope(scope, projectId);
			}
		: undefined;
	await Promise.all([
		qc.invalidateQueries({ queryKey: qk.events.all, predicate }),
		qc.invalidateQueries({ queryKey: qk.failures.all, predicate }),
		qc.invalidateQueries({ queryKey: ["overview"], predicate }),
		qc.invalidateQueries({ queryKey: ["destinations", "stats"], predicate }),
	]);
}
