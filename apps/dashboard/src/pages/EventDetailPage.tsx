import { useState } from "react";
import { DeliveryTimeline } from "@/components/DeliveryTimeline";
import { IdText } from "@/components/IdText";
import { JsonViewer } from "@/components/JsonViewer";
import { LoadError } from "@/components/LoadError";
import { PayloadPanel } from "@/components/PayloadPanel";
import { ReplayDialog } from "@/components/ReplayDialog";
import { TimeText } from "@/components/TimeText";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { Can, useCan } from "@/lib/permissions";
import { useEvent } from "@/lib/queries/events";
import { formatBytes } from "@/lib/time";

type InspectorTab = "headers" | "payload";

export function EventDetailPage({ eventId }: { eventId: string }) {
	const event = useEvent(eventId);
	const [replaying, setReplaying] = useState(false);
	const [tab, setTab] = useState<InspectorTab>("headers");
	const [payloadMissing, setPayloadMissing] = useState(false);
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
	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center gap-3">
				<h1 className="font-mono text-lg">{e.id}</h1>
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
					Replay needs the payload, which is no longer available, so replay
					is disabled for this event.
				</p>
			)}
			<div className="grid items-start gap-6 lg:grid-cols-[3fr_2fr]">
				<section aria-labelledby="deliveries-heading" className="space-y-3">
					<h2 id="deliveries-heading" className="font-semibold">
						Deliveries
					</h2>
					{deliveries.map((d, i) => (
						<section key={d.id} aria-label={`Delivery ${d.id}`}>
							<DeliveryTimeline
								delivery={d}
								receivedAt={e.received_at}
								defaultOpen={i === 0}
							/>
						</section>
					))}
				</section>
				<section aria-labelledby="inspector-heading" className="space-y-4">
					<h2 id="inspector-heading" className="font-semibold">
						Request inspector
					</h2>
					<div role="tablist" aria-label="Request inspector views">
						{(["headers", "payload"] as const).map((t) => (
							<Button
								key={t}
								role="tab"
								variant={tab === t ? "secondary" : "ghost"}
								size="sm"
								aria-selected={tab === t}
								onClick={() => setTab(t)}
							>
								{t === "headers" ? "Headers" : "Payload"}
							</Button>
						))}
					</div>
					<div role="tabpanel">
						{tab === "headers" ? (
							<JsonViewer value={e.headers} />
						) : canReadPayload ? (
							<PayloadPanel
								eventId={e.id}
								contentType={e.content_type}
								size={e.size_bytes}
								onMissing={() => setPayloadMissing(true)}
							/>
						) : (
							<p className="text-sm text-muted-foreground">
								Payload inspection requires the{" "}
								<span className="font-mono">payload.read</span> permission,
								which this account does not have. Headers above remain
								visible.
							</p>
						)}
					</div>
					<dl className="grid grid-cols-2 gap-3 text-sm">
						<div>
							<dt className="text-muted-foreground">Received</dt>
							<dd>
								<TimeText ms={e.received_at} />
							</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">Source</dt>
							<dd>
								<IdText id={e.source_id} />
							</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">Provider event ID</dt>
							<dd className="font-mono text-xs">
								{e.provider_event_id ? (
									<IdText id={e.provider_event_id} />
								) : (
									"—"
								)}
							</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">Size</dt>
							<dd>
								{formatBytes(e.size_bytes)} · {e.content_type ?? "unknown type"}
							</dd>
						</div>
					</dl>
					<details>
						<summary className="cursor-pointer text-sm underline">
							Payload hash
						</summary>
						<div className="mt-1">
							<IdText id={e.payload_sha256} />
						</div>
					</details>
				</section>
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
