import type { Alert, AlertDetail, Page } from "@hookflare/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { qk } from "./keys";

export type AlertScope = { project_id: string } | { scope: "deployment" };

type AlertFilters = {
	status?: "open" | "resolved";
	rule?: string;
} & AlertScope;

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

export function useAlert(id: string, scope?: AlertScope) {
	return useQuery({
		queryKey: qk.alerts.one(id, scope ?? null),
		queryFn: () => api.get<AlertDetail>(`/alerts/${id}`, scope),
		refetchInterval: (q) =>
			scope && q.state.data?.status === "open" ? 60_000 : false,
		refetchIntervalInBackground: false,
	});
}
