import type { Delivery } from "@hookflare/shared";
import { useState } from "react";
import { StatusBadge } from "./StatusBadge";
import { TimeText } from "./TimeText";

const TERMINAL: Record<string, string> = {
	delivered: "Delivered",
	failed_final: "Failed final",
	dead: "Dead",
};

/** Spec §11: Received → attempts → retrying / pending / terminal. */
export function DeliveryTimeline({
	delivery,
	receivedAt,
}: {
	delivery: Delivery;
	receivedAt: number;
}) {
	const terminal = TERMINAL[delivery.status];
	return (
		<section className="rounded border p-4">
			<header className="mb-3 flex items-center gap-2">
				<span className="font-mono text-xs">{delivery.id}</span>
				{delivery.kind === "replay" && (
					<span className="rounded bg-blue-50 px-1.5 text-xs text-blue-800">
						replay
					</span>
				)}
				<StatusBadge status={delivery.status} />
				{delivery.created_by && (
					<span className="text-xs text-neutral-500">
						by {delivery.created_by}
					</span>
				)}
			</header>
			<ol className="space-y-2 border-l pl-4">
				<li data-step="received">
					<span className="font-medium">Received</span>{" "}
					<TimeText ms={receivedAt} />
				</li>
				{delivery.attempts.map((a) => (
					<AttemptRow key={a.id} attempt={a} />
				))}
				{delivery.status === "retrying" && (
					<li data-step="retrying" className="text-amber-800">
						Retrying — next attempt <TimeText ms={delivery.next_attempt_at} />
					</li>
				)}
				{(delivery.status === "paused" ||
					delivery.status === "queued" ||
					delivery.status === "pending") && (
					<li data-step="pending" className="text-neutral-500">
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
		</section>
	);
}

function AttemptRow({ attempt }: { attempt: Delivery["attempts"][number] }) {
	const [open, setOpen] = useState(false);
	const outcome =
		attempt.http_status !== null
			? `HTTP ${attempt.http_status}`
			: (attempt.error_kind ?? "error");
	return (
		<li data-step={`attempt-${attempt.attempt_no}`}>
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium">Attempt #{attempt.attempt_no}</span>
				<span>{outcome}</span>
				<span className="text-neutral-500">{attempt.duration_ms} ms</span>
				<TimeText ms={attempt.started_at} />
				{attempt.error_message && (
					<span className="text-red-700">{attempt.error_message}</span>
				)}
				{attempt.response_snippet && (
					<button
						type="button"
						className="text-xs underline"
						onClick={() => setOpen(!open)}
					>
						{open ? "Hide response" : "Show response"}
					</button>
				)}
			</div>
			{open && attempt.response_snippet && (
				<pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 text-xs">
					{attempt.response_snippet}
				</pre>
			)}
		</li>
	);
}
