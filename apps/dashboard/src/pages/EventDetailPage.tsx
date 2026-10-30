import { useState } from "react";
import { DeliveryTimeline } from "@/components/DeliveryTimeline";
import {
	EventDeliveryContext,
	SourceName,
} from "@/components/EventDeliveryContext";
import { EventInspector } from "@/components/EventInspector";
import { IdText } from "@/components/IdText";
import { LoadError } from "@/components/LoadError";
import { ReplayDialog } from "@/components/ReplayDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { Can, useCan } from "@/lib/permissions";
import { useEvent } from "@/lib/queries/events";

export function EventDetailPage({ eventId }: { eventId: string }) {
	const event = useEvent(eventId);
	const [replaying, setReplaying] = useState(false);
	const [selection, setSelection] = useState<{
		eventId: string;
		deliveryId: string;
		attemptId: string;
	} | null>(null);
	const [missingPayloadEventId, setMissingPayloadEventId] = useState<
		string | null
	>(null);
	const payloadMissing = missingPayloadEventId === eventId;
	const canReadPayload = useCan("payload.read");
	if (event.error instanceof ApiError && event.error.status === 404)
		return <p>Event {eventId} was not found.</p>;
	if (!event.data && event.isError)
		return (
			<LoadError
				what={`event ${eventId}`}
				error={event.error}
				retrying={event.isFetching}
				onRetry={() => void event.refetch()}
			/>
		);
	if (!event.data)
		return (
			<div
				role="status"
				aria-label="Loading"
				className="space-y-3 rounded-lg border border-border bg-card p-4"
			>
				{[0, 1, 2].map((i) => (
					<div key={i} aria-hidden="true" className="flex items-center gap-4">
						<Skeleton className="h-4 w-20 shrink-0" />
						<Skeleton className="h-4 w-40 shrink-0" />
						<Skeleton className="h-4 min-w-0 flex-1" />
					</div>
				))}
			</div>
		);
	const e = event.data;
	const deliveries = [...e.deliveries].sort(
		(a, b) => b.created_at - a.created_at,
	);
	const selectedDelivery =
		deliveries.find(
			(d) =>
				d.id === (selection?.eventId === e.id ? selection.deliveryId : null) &&
				d.attempts.some((a) => a.id === selection?.attemptId),
		) ??
		deliveries[0] ??
		null;
	const selectedAttempt =
		selectedDelivery?.attempts.find(
			(a) =>
				a.id === (selection?.eventId === e.id ? selection.attemptId : null),
		) ??
		[...(selectedDelivery?.attempts ?? [])].sort(
			(a, b) => b.attempt_no - a.attempt_no,
		)[0] ??
		null;
	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center gap-3">
				<div className="min-w-0">
					<h1 className="break-all text-[26px] font-semibold">{e.id}</h1>
					<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
						<IdText id={e.id} />
						<span>Project {e.project_id}</span>
						{e.source_id && <SourceName id={e.source_id} />}
					</div>
				</div>
				{deliveries[0] && <StatusBadge status={deliveries[0].status} />}
				<Button variant="outline" onClick={() => void event.refetch()}>
					Refresh event
				</Button>
				<div className="ml-auto">
					<Can permission="deliveries.replay">
						<Button
							disabled={payloadMissing}
							onClick={() => setReplaying(true)}
						>
							Replay
						</Button>
					</Can>
				</div>
			</div>
			{payloadMissing && (
				<p role="status" className="text-sm text-muted-foreground">
					Replay needs the payload, which is no longer available, so replay is
					disabled for this event.
				</p>
			)}
			<EventDeliveryContext event={e} delivery={selectedDelivery} />
			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
				<section
					aria-labelledby="deliveries-heading"
					className="min-w-0 space-y-3"
				>
					<h2 id="deliveries-heading" className="font-semibold">
						Deliveries
					</h2>
					{deliveries.length === 0 && (
						<p className="rounded-lg border bg-card p-5 text-sm text-muted-foreground">
							No deliveries yet for this event.
						</p>
					)}
					{deliveries.map((d, i) => (
						<section key={d.id} aria-label={`Delivery ${d.id}`}>
							<DeliveryTimeline
								delivery={d}
								receivedAt={e.received_at}
								defaultOpen={i === 0}
								selectedAttemptId={
									selectedDelivery?.id === d.id
										? selectedAttempt?.id
										: undefined
								}
								onSelectAttempt={(a) =>
									setSelection({
										eventId: e.id,
										deliveryId: d.id,
										attemptId: a.id,
									})
								}
							/>
						</section>
					))}
				</section>
				<EventInspector
					key={e.id}
					event={e}
					deliveryId={selectedDelivery?.id ?? null}
					attempt={selectedAttempt}
					canReadPayload={canReadPayload}
					onPayloadMissing={() => setMissingPayloadEventId(e.id)}
				/>
			</div>
			<ReplayDialog
				open={replaying}
				onOpenChange={setReplaying}
				target={{ kind: "event", eventId: e.id }}
				onDone={() => void event.refetch()}
			/>
		</div>
	);
}
