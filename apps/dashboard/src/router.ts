import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { toast } from "sonner";
import { ApiError } from "./lib/api";
import { routeTree } from "./routeTree.gen";

export function createQueryClient() {
	const client: QueryClient = new QueryClient({
		queryCache: new QueryCache({
			onError: (err, query) => onApiError(client, err, query?.queryKey),
		}),
		mutationCache: new MutationCache({
			onError: (err) => onApiError(client, err),
		}),
		defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
	});
	return client;
}

/** Spec M4-12: a 403 means the role changed mid-session; reload /me so the UI hides the action. */
function onApiError(
	client: QueryClient,
	err: unknown,
	queryKey?: readonly unknown[],
) {
	if (!(err instanceof ApiError) || err.status !== 403) return;
	// A 403 from /me itself would mean the session lost its user; invalidating
	// ["me"] here would refetch it in a tight loop.
	if (queryKey?.[0] === "me") return;
	toast.error("You do not have permission for that action.");
	void client.invalidateQueries({ queryKey: ["me"] });
}

export function createAppRouter(
	queryClient: QueryClient,
	history?: RouterHistory,
) {
	return createRouter({
		routeTree,
		context: { queryClient },
		history,
		defaultPreload: false,
	});
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createAppRouter>;
	}
}
