import type { Overview, StatsRange } from "@hookflare/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { qk } from "./keys";

/** Refetch every 15 s while the tab is visible (spec §9.2). */
export function useOverview(q: { project_id?: string; range: StatsRange }) {
	return useQuery({
		queryKey: qk.overview(q),
		queryFn: () => api.get<Overview>("/overview", q),
		refetchInterval: 15_000,
		refetchIntervalInBackground: false,
	});
}
