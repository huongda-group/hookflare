import type { QueryClient } from "@tanstack/react-query";
import { qk } from "./keys";

export function matchesProjectScope(
	scope: unknown,
	projectId: string,
): boolean {
	return (
		scope === projectId ||
		(typeof scope === "object" &&
			scope !== null &&
			"project_id" in scope &&
			scope.project_id === projectId)
	);
}

export async function invalidateEndpointViews(
	qc: QueryClient,
	kind: "source" | "destination",
	projectId: string,
) {
	await Promise.all([
		qc.invalidateQueries({
			queryKey: qk[`${kind}s`].all,
			predicate: ({ queryKey }) => matchesProjectScope(queryKey[2], projectId),
		}),
		qc.invalidateQueries({ queryKey: qk.resourceOptions(kind, projectId) }),
	]);
}
