import type { EventSummary, Page, WebhookEvent } from "@hookflare/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { qk } from "./keys";

const ACTIVE = new Set([
	"pending",
	"queued",
	"in_flight",
	"retrying",
	"paused",
]);

export type EventFilters = {
	project_id?: string;
	source_id?: string;
	destination_id?: string;
	status?: string[];
	http_status?: number;
	provider_event_id?: string;
	from?: number;
	to?: number;
};

export function useEventsPage(f: EventFilters) {
	return useInfiniteQuery({
		queryKey: qk.events.list(f),
		queryFn: ({ pageParam }) =>
			api.get<Page<EventSummary>>("/events", {
				...f,
				limit: 50,
				cursor: pageParam,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});
}

/** Polls only while something can still change (spec §9.2). */
export function useEvent(id: string) {
	return useQuery({
		queryKey: qk.events.one(id),
		queryFn: () => api.get<WebhookEvent>(`/events/${id}`),
		refetchInterval: (q) =>
			q.state.data?.deliveries.some((d) => ACTIVE.has(d.status))
				? 15_000
				: false,
		refetchIntervalInBackground: false,
	});
}
