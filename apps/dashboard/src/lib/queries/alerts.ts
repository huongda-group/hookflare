import type { Alert, AlertDetail, Page } from "@hookflare/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { qk } from "./keys";

export type AlertFilters = {
	status?: "open" | "resolved";
	rule?: string;
	project_id?: string;
};

/** Incidents change every minute at most (the job's cadence). */
export function useAlertsPage(f: AlertFilters) {
	return useInfiniteQuery({
		queryKey: qk.alerts.list(f),
		queryFn: ({ pageParam }) =>
			api.get<Page<Alert>>("/alerts", { ...f, limit: 50, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next_cursor ?? undefined,
		refetchInterval: 60_000,
		refetchIntervalInBackground: false,
	});
}

export function useAlert(id: string) {
	return useQuery({
		queryKey: qk.alerts.one(id),
		queryFn: () => api.get<AlertDetail>(`/alerts/${id}`),
		refetchInterval: (q) => (q.state.data?.status === "open" ? 60_000 : false),
		refetchIntervalInBackground: false,
	});
}
