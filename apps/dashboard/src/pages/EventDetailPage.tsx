import { useState } from "react";
import { DeliveryTimeline } from "@/components/DeliveryTimeline";
import { IdText } from "@/components/IdText";
import { JsonViewer } from "@/components/JsonViewer";
import { LoadError } from "@/components/LoadError";
import { PayloadPanel } from "@/components/PayloadPanel";
import { ReplayDialog } from "@/components/ReplayDialog";
import { TimeText } from "@/components/TimeText";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { Can } from "@/lib/permissions";
import { useEvent } from "@/lib/queries/events";
import { formatBytes } from "@/lib/time";

export function EventDetailPage({ eventId }: { eventId: string }) {
	const event = useEvent(eventId);
	const [replaying, setReplaying] = useState(false);
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
	if (!event.data) return <p className="text-neutral-500">Loading…</p>;
	const e = event.data;
	const deliveries = [...e.deliveries].sort(
		(a, b) => b.created_at - a.created_at,
	);
	return (
		<div className="space-y-6">
			<div className="flex items-center gap-3">
				<h1 className="font-mono text-lg">{e.id}</h1>
				<div className="ml-auto">
					<Can permission="deliveries.replay">
						<Button onClick={() => setReplaying(true)}>Replay</Button>
					</Can>
				</div>
			</div>
			<dl className="grid grid-cols-4 gap-3 text-sm">
				<div>
					<dt className="text-neutral-500">Received</dt>
					<dd>
						<TimeText ms={e.received_at} />
					</dd>
				</div>
				<div>
					<dt className="text-neutral-500">Source</dt>
					<dd>
						<IdText id={e.source_id} />
					</dd>
				</div>
				<div>
					<dt className="text-neutral-500">Provider event ID</dt>
					<dd className="font-mono text-xs">{e.provider_event_id ?? "—"}</dd>
				</div>
				<div>
					<dt className="text-neutral-500">Size</dt>
					<dd>
						{formatBytes(e.size_bytes)} · {e.content_type ?? "unknown type"}
					</dd>
				</div>
			</dl>
			<section>
				<h2 className="mb-2 font-semibold">Headers</h2>
				<JsonViewer value={e.headers} />
			</section>
			<section>
				<h2 className="mb-2 font-semibold">Payload</h2>
				<Can permission="payload.read">
					<PayloadPanel
						eventId={e.id}
						contentType={e.content_type}
						size={e.size_bytes}
					/>
				</Can>
				<p className="mt-1 font-mono text-xs text-neutral-500">
					sha256 {e.payload_sha256}
				</p>
			</section>
			<section className="space-y-3">
				<h2 className="font-semibold">Deliveries</h2>
				{deliveries.map((d) => (
					<section key={d.id} aria-label={`Delivery ${d.id}`}>
						<DeliveryTimeline delivery={d} receivedAt={e.received_at} />
					</section>
				))}
			</section>
			<ReplayDialog
				open={replaying}
				onOpenChange={setReplaying}
				target={{ kind: "event", eventId: e.id }}
				onDone={() => void event.refetch()}
			/>
		</div>
	);
}
