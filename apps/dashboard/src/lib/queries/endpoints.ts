import type {
	BackupSummary,
	Destination,
	DestinationStats,
	Page,
	Settings,
	Source,
	TestDelivery,
} from "@hookflare/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { qk } from "./keys";

export function useDestinationsPage(q: { project_id?: string }) {
	return useInfiniteQuery({
		queryKey: qk.destinations.list(q),
		queryFn: ({ pageParam }) =>
			api.get<Page<Destination>>("/destinations", {
				...q,
				limit: 50,
				cursor: pageParam,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});
}

export function useDestinationStats(projectId?: string) {
	return useQuery({
		queryKey: qk.destinations.stats({ project_id: projectId }),
		queryFn: () =>
			api.get<{ data: DestinationStats[] }>("/destinations/stats", {
				project_id: projectId,
			}),
		select: (r) => new Map(r.data.map((s) => [s.destination_id, s])),
	});
}

export function useSourcesPage(q: { project_id?: string }) {
	return useInfiniteQuery({
		queryKey: qk.sources.list(q),
		queryFn: ({ pageParam }) =>
			api.get<Page<Source>>("/sources", { ...q, limit: 50, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});
}

export function useSettings() {
	return useQuery({
		queryKey: qk.settings,
		queryFn: () => api.get<Settings>("/settings"),
	});
}

export function useBackupSummary() {
	return useQuery({
		queryKey: qk.backups.summary,
		queryFn: () => api.get<BackupSummary>("/backups/summary"),
	});
}

export function useDestination(id: string, projectId: string) {
	return useQuery({
		queryKey: qk.destinations.one(id, projectId),
		queryFn: () =>
			api.get<Destination>(`/destinations/${id}`, { project_id: projectId }),
	});
}

/** Spec §11: the destination detail page lists its test deliveries. */
export function useDestinationTests(id: string, projectId: string) {
	return useInfiniteQuery({
		queryKey: qk.destinations.tests(id, projectId),
		queryFn: ({ pageParam }) =>
			api.get<Page<TestDelivery>>(`/destinations/${id}/tests`, {
				project_id: projectId,
				limit: 20,
				cursor: pageParam,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});
}

export function useSource(id: string, projectId: string) {
	return useQuery({
		queryKey: qk.sources.one(id, projectId),
		queryFn: () => api.get<Source>(`/sources/${id}`, { project_id: projectId }),
	});
}
