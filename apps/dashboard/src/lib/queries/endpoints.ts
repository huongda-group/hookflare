import type {
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

export function useDestinationsList(projectId?: string) {
	return useQuery({
		queryKey: qk.destinations.list({ project_id: projectId, all: true }),
		queryFn: () =>
			api.get<Page<Destination>>("/destinations", {
				project_id: projectId,
				limit: 200,
			}),
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

export function useDestination(id: string) {
	return useQuery({
		queryKey: qk.destinations.one(id),
		queryFn: () => api.get<Destination>(`/destinations/${id}`),
	});
}

/** Spec §11: the destination detail page lists its test deliveries. */
export function useDestinationTests(id: string) {
	return useInfiniteQuery({
		queryKey: qk.destinations.tests(id),
		queryFn: ({ pageParam }) =>
			api.get<Page<TestDelivery>>(`/destinations/${id}/tests`, {
				limit: 20,
				cursor: pageParam,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});
}

export function useSource(id: string) {
	return useQuery({
		queryKey: qk.sources.one(id),
		queryFn: () => api.get<Source>(`/sources/${id}`),
	});
}
