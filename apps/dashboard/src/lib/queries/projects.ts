import type { Page, Project } from "@hookflare/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { qk } from "./keys";

/** For selects: one page of up to 200 (listQuery max) is enough for an internal tool. */
export function useProjectsList() {
	return useQuery({
		queryKey: qk.projects.list({ all: true }),
		queryFn: () => api.get<Page<Project>>("/projects", { limit: 200 }),
	});
}

export function useProjectsPage() {
	return useInfiniteQuery({
		queryKey: qk.projects.list({}),
		queryFn: ({ pageParam }) =>
			api.get<Page<Project>>("/projects", { limit: 50, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});
}

export function useProject(id: string) {
	return useQuery({
		queryKey: qk.projects.one(id),
		queryFn: () => api.get<Project>(`/projects/${id}`),
	});
}
