import type { EventSummary } from "@hookflare/shared";
import { Link } from "@tanstack/react-router";
import { ResourceLabel } from "@/components/ResourceLabel";
import { StatusBadge } from "@/components/StatusBadge";
import { TimeText } from "@/components/TimeText";
import { useResourceOptions } from "@/lib/queries/resource-options";

function ResourceCache({
	kind,
	projectId,
}: {
	kind: "source" | "destination";
	projectId?: string;
}) {
	void useResourceOptions(kind, projectId);
	return null;
}

export function RecentEventsTable({ events }: { events: EventSummary[] }) {
	const scopes = [...new Set(events.map((event) => event.project_id))];
	return (
		<div className="overflow-hidden rounded-[10px] border border-border bg-card">
			{scopes.map((projectId) => (
				<span key={projectId}>
					<ResourceCache kind="source" projectId={projectId} />
					<ResourceCache kind="destination" projectId={projectId} />
				</span>
			))}
			<section aria-label="Recent events" className="overflow-x-auto">
				<table aria-label="Recent events" className="w-full text-left text-xs">
					<thead className="hidden border-b border-border bg-muted/30 text-muted-foreground md:table-header-group">
						<tr>
							<th scope="col" className="px-4 py-3 font-medium">
								Event
							</th>
							<th scope="col" className="px-4 py-3 font-medium">
								Source → Destination
							</th>
							<th scope="col" className="px-4 py-3 font-medium">
								Latest delivery
							</th>
							<th scope="col" className="px-4 py-3 font-medium">
								HTTP
							</th>
							<th scope="col" className="px-4 py-3 text-right font-medium">
								Received
							</th>
						</tr>
					</thead>
					<tbody>
						{events.map((event) => (
							<tr
								key={event.id}
								className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-border px-4 py-3 last:border-0 md:table-row md:px-0 md:py-0 md:hover:bg-accent/40"
							>
								<td className="min-w-0 md:px-4 md:py-3">
									<Link
										to="/events/$eventId"
										params={{ eventId: event.id }}
										className="break-all font-mono font-medium text-action underline-offset-2 hover:underline"
									>
										{event.id}
									</Link>
								</td>
								<td className="col-start-1 min-w-0 text-muted-foreground md:px-4 md:py-3">
									<ResourceLabel
										kind="source"
										id={event.source_id}
										projectId={event.project_id}
									/>{" "}
									<span aria-hidden="true">→</span>{" "}
									{event.latest_delivery ? (
										<ResourceLabel
											kind="destination"
											id={event.latest_delivery.destination_id}
											projectId={event.project_id}
										/>
									) : (
										<span>No delivery</span>
									)}
								</td>
								<td className="col-start-2 row-start-1 text-right md:px-4 md:py-3 md:text-left">
									{event.latest_delivery ? (
										<StatusBadge status={event.latest_delivery.status} />
									) : (
										<span className="text-muted-foreground">No delivery</span>
									)}
								</td>
								<td className="hidden font-mono text-muted-foreground md:table-cell md:px-4 md:py-3">
									{event.latest_delivery?.last_http_status ?? "—"}
								</td>
								<td className="col-start-2 row-start-2 text-right text-muted-foreground md:px-4 md:py-3">
									<TimeText ms={event.received_at} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
			<p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
				Showing {events.length.toLocaleString("en-US")} recent events · Latest
				delivery per event
			</p>
		</div>
	);
}
