import type { Page, Project } from "@hookflare/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { qk } from "./keys";

export function useProjectCatalog(enabled: boolean) {
	return useQuery({
		queryKey: qk.projects.list({ catalog: true }),
		enabled,
		queryFn: async () => {
			const projects: Project[] = [];
			let cursor: string | undefined;
			do {
				const page: Page<Project> = await api.get("/projects", {
					limit: 200,
					cursor,
				});
				projects.push(...page.data);
				cursor = page.next_cursor ?? undefined;
			} while (cursor);
			return projects;
		},
	});
}

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
