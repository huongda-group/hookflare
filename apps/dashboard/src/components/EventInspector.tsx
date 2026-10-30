import type { DeliveryAttempt, WebhookEvent } from "@hookflare/shared";
import { useState } from "react";
import { formatBytes } from "@/lib/time";
import { IdText } from "./IdText";
import { JsonViewer } from "./JsonViewer";
import { PayloadPanel } from "./PayloadPanel";
import { TimeText } from "./TimeText";

type Tab = "response" | "headers" | "payload";

export function EventInspector({
	event,
	deliveryId,
	attempt,
	canReadPayload,
	onPayloadMissing,
}: {
	event: WebhookEvent;
	deliveryId?: string | null;
	attempt: DeliveryAttempt | null;
	canReadPayload: boolean;
	onPayloadMissing: () => void;
}) {
	const [tab, setTab] = useState<Tab>("response");
	return (
		<section
			aria-labelledby="inspector-heading"
			className="min-w-0 space-y-4 rounded-lg border bg-card p-5"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 id="inspector-heading" className="font-semibold">
					Request &amp; response inspector
				</h2>
				{deliveryId && (
					<span className="break-all text-xs text-muted-foreground">
						Delivery {deliveryId}
						{attempt
							? ` · Selected attempt ${attempt.attempt_no}`
							: " · No attempts yet"}
					</span>
				)}
			</div>
			<div
				role="tablist"
				aria-label="Request inspector views"
				className="flex flex-wrap gap-1 border-b"
			>
				{(["response", "headers", "payload"] as const).map((t) => (
					<button
						key={t}
						type="button"
						role="tab"
						aria-selected={tab === t}
						onClick={() => setTab(t)}
						className={`min-h-11 border-b-2 px-3 text-sm ${tab === t ? "border-action text-action" : "border-transparent text-muted-foreground"}`}
					>
						{t === "headers"
							? "Request headers"
							: t === "response"
								? "Response"
								: "Payload"}
					</button>
				))}
			</div>
			<div role="tabpanel" className="min-w-0">
				{tab === "response" ? (
					<div className="space-y-3 text-sm">
						{attempt ? (
							<>
								<p>
									{attempt.http_status === null
										? (attempt.error_kind ?? "No HTTP response")
										: `HTTP ${attempt.http_status}`}
									{attempt.error_message ? ` · ${attempt.error_message}` : ""}
								</p>
								<p className="text-xs text-muted-foreground">
									Stored response snippet · {attempt.duration_ms} ms
								</p>
								{attempt.response_snippet ? (
									<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-secondary p-3 font-mono text-xs">
										{attempt.response_snippet}
									</pre>
								) : (
									<p className="text-muted-foreground">
										Response snippet unavailable for this attempt.
									</p>
								)}
							</>
						) : (
							<p className="text-muted-foreground">
								No attempt is available for inspection.
							</p>
						)}
					</div>
				) : tab === "headers" ? (
					<div className="space-y-2">
						<p className="text-xs text-muted-foreground">
							Accepted event request headers (redacted); not outbound attempt
							headers.
						</p>
						<JsonViewer value={event.headers} />
					</div>
				) : canReadPayload ? (
					<PayloadPanel
						eventId={event.id}
						contentType={event.content_type}
						size={event.size_bytes}
						onMissing={onPayloadMissing}
					/>
				) : (
					<p className="text-sm text-muted-foreground">
						Payload inspection requires the{" "}
						<span className="font-mono">payload.read</span> permission, which
						this account does not have. Headers above remain visible.
					</p>
				)}
			</div>
			<dl className="grid grid-cols-2 gap-3 text-sm">
				<div>
					<dt className="text-muted-foreground">Received</dt>
					<dd>
						<TimeText ms={event.received_at} />
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">Source</dt>
					<dd>
						<IdText id={event.source_id} />
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">Provider event ID</dt>
					<dd>
						{event.provider_event_id ? (
							<IdText id={event.provider_event_id} />
						) : (
							"—"
						)}
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">Size</dt>
					<dd>
						{formatBytes(event.size_bytes)} ·{" "}
						{event.content_type ?? "unknown type"}
					</dd>
				</div>
			</dl>
			<details>
				<summary className="cursor-pointer text-sm underline">
					Payload hash
				</summary>
				<IdText id={event.payload_sha256} />
			</details>
		</section>
	);
}
