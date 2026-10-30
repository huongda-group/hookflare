import type { Delivery, DeliveryAttempt } from "@hookflare/shared";
import { useState } from "react";
import { StatusBadge } from "./StatusBadge";
import { TimeText } from "./TimeText";

const TERMINAL: Record<string, string> = {
	delivered: "Delivered",
	failed_final: "Failed final",
	dead: "Dead",
};

/**
 * Spec §11: Received (or, for a replay, its creation) → attempts → retrying /
 * pending / terminal. Attempts render chronologically. The attempt list is
 * collapsible so an event with many deliveries keeps every history in the DOM
 * without forcing the reader past all of it; collapsed responses and
 * collapsed deliveries are not mounted until opened.
 */
export function DeliveryTimeline({
	delivery,
	receivedAt,
	defaultOpen = true,
	selectedAttemptId,
	onSelectAttempt,
}: {
	delivery: Delivery;
	receivedAt: number;
	/** Newest delivery on the page renders open; older ones render collapsed. */
	defaultOpen?: boolean;
	selectedAttemptId?: string;
	onSelectAttempt?: (attempt: DeliveryAttempt) => void;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const terminal = TERMINAL[delivery.status];
	const attempts = [...delivery.attempts].sort(
		(a, b) => a.attempt_no - b.attempt_no,
	);
	const summary: Record<string, string> = {
		dead: "Delivery stopped after retries were exhausted. No further automatic retry is scheduled.",
		failed_final:
			"Delivery failed final. No further automatic retry is scheduled.",
		delivered: "Delivery completed successfully.",
		retrying:
			delivery.next_attempt_at === null
				? "Retrying; next attempt time unavailable."
				: "Retrying; next attempt is scheduled below.",
		paused: "Delivery paused; no attempt is currently in progress.",
		pending: "Pending delivery; awaiting enqueue.",
		queued: "Delivery queued; awaiting an attempt.",
		in_flight: "Delivery in flight; an attempt is in progress.",
	};
	return (
		<section className="rounded-lg border bg-card p-4">
			<header className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen(!open)}
					className="inline-flex min-w-0 flex-wrap items-center gap-2 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					aria-label={`${open ? "Collapse" : "Expand"} delivery ${delivery.id}`}
				>
					<span aria-hidden="true" className="text-xs text-muted-foreground">
						{open ? "▾" : "▸"}
					</span>
					<span className="font-mono text-xs">{delivery.id}</span>
				</button>
				{delivery.kind === "replay" && (
					<span className="rounded bg-info-surface px-1.5 text-xs text-info">
						replay
					</span>
				)}
				<StatusBadge status={delivery.status} />
				{delivery.created_by && (
					<span className="text-xs text-muted-foreground">
						by {delivery.created_by}
					</span>
				)}
			</header>
			<p className="mt-3 rounded-md bg-secondary p-3 text-xs text-muted-foreground">
				{summary[delivery.status]}
			</p>
			{open && (
				<ol className="mt-3 space-y-2 border-l pl-4">
					{delivery.kind === "replay" ? (
						<li data-step="created">
							<span className="font-medium">Created</span>{" "}
							<TimeText ms={delivery.created_at} />
						</li>
					) : (
						<li data-step="received">
							<span className="font-medium">Received</span>{" "}
							<TimeText ms={receivedAt} />
						</li>
					)}
					{attempts.map((a) => (
						<AttemptRow
							key={a.id}
							attempt={a}
							selected={a.id === selectedAttemptId}
							onSelect={onSelectAttempt}
						/>
					))}
					{delivery.status === "retrying" &&
						delivery.next_attempt_at !== null && (
							<li data-step="retrying" className="text-warning">
								Retrying — next attempt{" "}
								<TimeText ms={delivery.next_attempt_at} />
							</li>
						)}
					{delivery.status === "in_flight" && (
						<li data-step="in_flight" className="text-muted-foreground">
							In flight — attempt in progress
						</li>
					)}
					{(delivery.status === "paused" ||
						delivery.status === "queued" ||
						delivery.status === "pending") && (
						<li data-step="pending" className="text-muted-foreground">
							{delivery.status === "paused"
								? "Pending — destination paused"
								: "Pending — waiting in queue"}
						</li>
					)}
					{terminal && (
						<li data-step={delivery.status} className="font-medium">
							{terminal} <TimeText ms={delivery.completed_at} />
						</li>
					)}
				</ol>
			)}
		</section>
	);
}

function AttemptRow({
	attempt,
	selected,
	onSelect,
}: {
	attempt: DeliveryAttempt;
	selected: boolean;
	onSelect?: (attempt: DeliveryAttempt) => void;
}) {
	const [open, setOpen] = useState(false);
	const outcome =
		attempt.http_status !== null
			? `HTTP ${attempt.http_status}`
			: (attempt.error_kind ?? "error");
	return (
		<li data-step={`attempt-${attempt.attempt_no}`}>
			<div className="flex flex-wrap items-center gap-2">
				{onSelect ? (
					<button
						type="button"
						aria-pressed={selected}
						onClick={() => onSelect(attempt)}
						className={`min-h-10 rounded-md border px-2 text-left font-medium focus-visible:outline-2 focus-visible:outline-ring [@media(pointer:coarse)]:min-h-11 ${selected ? "border-action bg-info-surface" : "border-border"}`}
					>
						<span>Attempt #{attempt.attempt_no}</span> · {outcome}
					</button>
				) : (
					<>
						<span className="font-medium">Attempt #{attempt.attempt_no}</span>
						<span>{outcome}</span>
					</>
				)}
				<span className="text-muted-foreground">{attempt.duration_ms} ms</span>
				<TimeText ms={attempt.started_at} />
				{attempt.error_message && (
					<span className="text-failure">{attempt.error_message}</span>
				)}
				{!onSelect && attempt.response_snippet && (
					<button
						type="button"
						aria-expanded={open}
						className="text-xs underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						onClick={() => setOpen(!open)}
					>
						{open ? "Hide response" : "Show response"}
					</button>
				)}
			</div>
			{open && attempt.response_snippet && (
				<pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-secondary p-2 text-xs break-all">
					{attempt.response_snippet}
				</pre>
			)}
		</li>
	);
}
