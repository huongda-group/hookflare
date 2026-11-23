import type { Me } from "@hookflare/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { qk } from "./keys";

export function useMeQuery() {
	return useQuery({
		queryKey: qk.me,
		queryFn: () => api.get<Me>("/me"),
		staleTime: (query) =>
			query.state.data?.project_required ? 0 : Number.POSITIVE_INFINITY,
	});
}
