import type { BulkReplayResult, ReplayResult } from "@hookflare/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/StatusBadge";
import { api } from "@/lib/api";
import { errorText } from "@/lib/forms";
import { invalidateDeliveryViews } from "@/lib/queries/invalidate-delivery-views";

export type ReplayTarget =
	| { kind: "event"; eventId: string }
	| {
			kind: "bulk";
			deliveryIds: string[];
			/** Original failure → event, so new deliveries link to their event. */
			eventsByDelivery?: Record<string, string>;
	  };
type OutcomeEntry = {
	from: string;
	to: string;
	enqueued: boolean;
	status?: string;
	eventId?: string;
};
type Outcome = {
	replayed: OutcomeEntry[];
	skipped: { delivery_id: string; reason: string }[];
};

/**
 * Immutable snapshot of what the user submitted. The live target prop may
 * change — page filters can clear the caller's selection — while the POST is
 * in flight, so the mutation and the result view only read this snapshot.
 */
type Submission = { target: ReplayTarget; reason: string };

/**
 * The bulk endpoint returns one row per replayed delivery. The shared
 * `BulkReplayResult` row carries `delivery_id`/`new_delivery_id`/`enqueued`;
 * a row may additionally carry the new delivery's `status` (same field name
 * as `ReplayResult.status`), which the outcome view needs for the
 * paused/not-enqueued branch. Read it defensively so older responses without
 * the field keep rendering the generic reconciler note.
 */
type BulkReplayResponse = {
	replayed: (BulkReplayResult["replayed"][number] & { status?: string })[];
	skipped: BulkReplayResult["skipped"];
};

async function replay({ target, reason }: Submission): Promise<Outcome> {
	if (target.kind === "event") {
		const r = await api.post<ReplayResult>(`/events/${target.eventId}/replay`, {
			reason,
		});
		return {
			replayed: [
				{
					from: target.eventId,
					to: r.delivery_id,
					enqueued: r.enqueued,
					status: r.status,
					eventId: target.eventId,
				},
			],
			skipped: [],
		};
	}
	const r = await api.post<BulkReplayResponse>("/failures/replay", {
		delivery_ids: target.deliveryIds,
		reason,
	});
	return {
		replayed: r.replayed.map((x) => ({
			from: x.delivery_id,
			to: x.new_delivery_id,
			enqueued: x.enqueued,
			status: x.status,
			eventId: target.eventsByDelivery?.[x.delivery_id],
		})),
		skipped: r.skipped,
	};
}

function OutcomeRow({ entry }: { entry: OutcomeEntry }) {
	return (
		<li>
			<span className="font-mono">{entry.from}</span> →{" "}
			{entry.eventId ? (
				<Link
					to="/events/$eventId"
					params={{ eventId: entry.eventId }}
					className="font-mono underline"
				>
					{entry.to}
				</Link>
			) : (
				<span className="font-mono">{entry.to}</span>
			)}
			{entry.status && (
				<span className="ml-2">
					<StatusBadge status={entry.status} />
				</span>
			)}
			{!entry.enqueued && (
				<span className="ml-2 text-warning">
					{entry.status === "paused"
						? "The destination is paused, so this replay is held until it is resumed."
						: "Saved but not queued yet — the reconciler enqueues it within a minute."}
				</span>
			)}
		</li>
	);
}

export function ReplayDialog({
	open,
	onOpenChange,
	target,
	onDone,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	target: ReplayTarget;
	onDone?: () => void;
}) {
	const qc = useQueryClient();
	const [reason, setReason] = useState("");
	const [invalid, setInvalid] = useState<string | null>(null);
	const selected = target.kind === "event" ? 1 : target.deliveryIds.length;
	// The submitted snapshot survives the caller clearing its selection in
	// onDone; the result view still names what was sent.
	const m = useMutation({
		mutationFn: (s: Submission) => replay(s),
		onSuccess: () => {
			void invalidateDeliveryViews(qc);
			onDone?.();
		},
	});
	const submitted = m.variables;
	const count = submitted
		? submitted.target.kind === "event"
			? 1
			: submitted.target.deliveryIds.length
		: selected;
	const data = m.data;
	const created = data?.replayed.filter((r) => r.enqueued) ?? [];
	const awaiting = data?.replayed.filter((r) => !r.enqueued) ?? [];
	const skipped = data?.skipped ?? [];
	const close = (o: boolean) => {
		if (!o) {
			m.reset();
			setReason("");
			setInvalid(null);
		}
		onOpenChange(o);
	};
	const onReasonChange = (value: string) => {
		setReason(value);
		// Live 1–500 validation: no maxLength cap, so over-length input stays
		// editable and surfaces the inline error immediately instead of being
		// silently truncated by the browser.
		if (value.trim().length > 500) {
			setInvalid("Reason must be 1–500 characters.");
		} else if (invalid !== null && value.trim().length > 0) {
			setInvalid(null);
		}
	};
	const submit = () => {
		const trimmed = reason.trim();
		if (!trimmed) {
			setInvalid("A reason is required (1–500 characters).");
			return;
		}
		if (trimmed.length > 500) {
			setInvalid("Reason must be 1–500 characters.");
			return;
		}
		setInvalid(null);
		const snapshot: ReplayTarget =
			target.kind === "event"
				? { kind: "event", eventId: target.eventId }
				: {
						kind: "bulk",
						deliveryIds: [...target.deliveryIds],
						eventsByDelivery: target.eventsByDelivery
							? { ...target.eventsByDelivery }
							: undefined,
					};
		m.mutate({ target: snapshot, reason: trimmed });
	};
	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						Replay {count === 1 ? "delivery" : `${count} deliveries`}
					</DialogTitle>
					<DialogDescription>
						Replay creates new deliveries and can trigger your backend again.
						Existing history is preserved.
					</DialogDescription>
				</DialogHeader>
				{data ? (
					<div className="space-y-3 text-sm">
						{created.length > 0 && (
							<section aria-label="Created">
								<p className="font-medium">Created ({created.length})</p>
								<ul className="space-y-1">
									{created.map((r) => (
										<OutcomeRow key={r.to} entry={r} />
									))}
								</ul>
							</section>
						)}
						{awaiting.length > 0 && (
							<section aria-label="Awaiting enqueue">
								<p className="font-medium">
									Awaiting enqueue ({awaiting.length})
								</p>
								<ul className="space-y-1">
									{awaiting.map((r) => (
										<OutcomeRow key={r.to} entry={r} />
									))}
								</ul>
							</section>
						)}
						{skipped.length > 0 && (
							<section aria-label="Skipped">
								<p className="font-medium">Skipped ({skipped.length})</p>
								<ul className="space-y-1">
									{skipped.map((s) => (
										<li key={s.delivery_id}>
											{s.delivery_id}: {s.reason}
										</li>
									))}
								</ul>
							</section>
						)}
						{created.length === 0 &&
							awaiting.length === 0 &&
							skipped.length === 0 && (
								<p role="status">
									No new deliveries were created. The selected failures are
									unchanged.
								</p>
							)}
						<DialogFooter>
							<Button onClick={() => close(false)}>Close</Button>
						</DialogFooter>
					</div>
				) : (
					<>
						<Label htmlFor="replay-reason">Reason</Label>
						<Textarea
							id="replay-reason"
							value={reason}
							onChange={(e) => onReasonChange(e.target.value)}
							aria-invalid={invalid !== null}
						/>
						{invalid && (
							<p className="text-sm text-red-700">{invalid}</p>
						)}
						{m.error && (
							<p className="text-sm text-red-700">{errorText(m.error)}</p>
						)}
						<DialogFooter>
							<Button variant="outline" onClick={() => close(false)}>
								Cancel
							</Button>
							<Button disabled={m.isPending} onClick={submit}>
								Replay {count}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
