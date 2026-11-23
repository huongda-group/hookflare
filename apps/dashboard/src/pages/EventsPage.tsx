import { DELIVERY_STATUS_VALUES, type EventSummary } from "@hookflare/shared";
import { useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { CursorTable } from "@/components/CursorTable";
import { EventFilters } from "@/components/EventFilters";
import { IdText } from "@/components/IdText";
import { ResourceLabel } from "@/components/ResourceLabel";
import { StatusBadge } from "@/components/StatusBadge";
import { TimeText } from "@/components/TimeText";
import { Button } from "@/components/ui/button";
import { useEventsPage } from "@/lib/queries/events";
import { formatBytes } from "@/lib/time";

export const eventsSearch = z.object({
	project_id: z.string().optional().catch(undefined),
	source_id: z.string().optional().catch(undefined),
	destination_id: z.string().optional().catch(undefined),
	status: z.array(z.enum(DELIVERY_STATUS_VALUES)).optional().catch(undefined),
	http_status: z.coerce
		.number()
		.int()
		.min(100)
		.max(599)
		.optional()
		.catch(undefined),
	provider_event_id: z.string().optional().catch(undefined),
	from: z.coerce.number().optional().catch(undefined),
	to: z.coerce.number().optional().catch(undefined),
});
export type EventsSearch = z.infer<typeof eventsSearch>;

const CLEARED: Partial<EventsSearch> = {
	source_id: undefined,
	destination_id: undefined,
	status: undefined,
	http_status: undefined,
	provider_event_id: undefined,
	from: undefined,
	to: undefined,
};

export function EventsPage({
	projectId,
	search,
	setSearch,
}: {
	projectId: string;
	search: EventsSearch;
	setSearch: (s: Partial<EventsSearch>) => void;
}) {
	const navigate = useNavigate();
	const filters = { ...search, project_id: projectId };
	const query = useEventsPage(filters);
	return (
		<div className="space-y-4">
			<h1 className="text-xl font-semibold">Events</h1>
			<EventFilters value={filters} onApply={(patch) => setSearch(patch)} />
			<p className="text-xs text-muted-foreground">
				Status and delivery columns describe the latest delivery for each event.
				A status filter matches delivery history, which can differ from the
				latest summary.
			</p>
			<CursorTable<EventSummary>
				query={query}
				rowKey={(e) => e.id}
				empty="No events match these filters."
				emptyAction={
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setSearch(CLEARED)}
					>
						Clear filters
					</Button>
				}
				getRowHref={(e) => `/events/${e.id}`}
				rowProjectId={projectId}
				onRowClick={(e) =>
					void navigate({
						to: "/events/$eventId",
						params: { eventId: e.id },
						search: { project_id: projectId },
					})
				}
				columns={[
					{ header: "Received", cell: (e) => <TimeText ms={e.received_at} /> },
					{ header: "Event ID", cell: (e) => <IdText id={e.id} /> },
					{
						header: "Provider ID",
						cell: (e) => (
							<span className="font-mono text-xs">
								{e.provider_event_id ?? "—"}
							</span>
						),
					},
					{
						header: "Source",
						cell: (e) => (
							<ResourceLabel
								kind="source"
								id={e.source_id}
								projectId={e.project_id}
							/>
						),
					},
					{
						header: "Latest destination",
						cell: (e) =>
							e.latest_delivery ? (
								<ResourceLabel
									kind="destination"
									id={e.latest_delivery.destination_id}
									projectId={e.project_id}
								/>
							) : (
								"—"
							),
					},
					{
						header: "Latest delivery status",
						cell: (e) =>
							e.latest_delivery ? (
								<StatusBadge status={e.latest_delivery.status} />
							) : (
								"—"
							),
					},
					{
						header: "HTTP",
						cell: (e) =>
							e.latest_delivery?.last_http_status
								? `HTTP ${e.latest_delivery.last_http_status}`
								: "—",
					},
					{
						header: "Attempts",
						cell: (e) => e.latest_delivery?.attempt_count ?? 0,
					},
					{
						header: "Next retry",
						cell: (e) => (
							<TimeText ms={e.latest_delivery?.next_attempt_at ?? null} />
						),
					},
					{ header: "Size", cell: (e) => formatBytes(e.size_bytes) },
				]}
			/>
		</div>
	);
}
