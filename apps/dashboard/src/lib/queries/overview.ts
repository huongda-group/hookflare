import type { Overview, StatsRange } from "@hookflare/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { qk } from "./keys";

/** Refetch every 15 s while the tab is visible (spec §9.2). */
export function useOverview(q: { project_id: string; range: StatsRange }) {
	const params = { ...q, alert_scope: "project" };
	return useQuery({
		queryKey: qk.overview(params),
		queryFn: () => api.get<Overview>("/overview", params),
		refetchInterval: 15_000,
		refetchIntervalInBackground: false,
	});
}
