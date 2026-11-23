import type { BulkReplayResult, ReplayResult } from "@hookflare/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { FormField } from "@/components/FormField";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api, projectScopedPath } from "@/lib/api";
import { errorText } from "@/lib/forms";
import { invalidateDeliveryViews } from "@/lib/queries/invalidate-delivery-views";

export type ReplayTarget =
	| { kind: "event"; eventId: string }
	| {
			kind: "bulk";
			deliveryIds: string[];
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

type Submission = { target: ReplayTarget; reason: string; projectId: string };

type BulkReplayResponse = {
	replayed: (BulkReplayResult["replayed"][number] & { status?: string })[];
	skipped: BulkReplayResult["skipped"];
};

async function replay({
	target,
	reason,
	projectId,
}: Submission): Promise<Outcome> {
	if (target.kind === "event") {
		const r = await api.post<ReplayResult>(
			projectScopedPath(`/events/${target.eventId}/replay`, projectId),
			{
				reason,
			},
		);
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
	const r = await api.post<BulkReplayResponse>(
		projectScopedPath("/failures/replay", projectId),
		{
			delivery_ids: target.deliveryIds,
			reason,
		},
	);
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

function OutcomeRow({
	entry,
	projectId,
}: {
	entry: OutcomeEntry;
	projectId: string;
}) {
	return (
		<li>
			<span className="font-mono">{entry.from}</span> →{" "}
			{entry.eventId ? (
				<Link
					to="/events/$eventId"
					params={{ eventId: entry.eventId }}
					search={{ project_id: projectId }}
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
	projectId,
	onDone,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	target: ReplayTarget;
	projectId: string;
	onDone?: () => void;
}) {
	const qc = useQueryClient();
	const [reason, setReason] = useState("");
	const [invalid, setInvalid] = useState<string | null>(null);
	const selected = target.kind === "event" ? 1 : target.deliveryIds.length;
	const m = useMutation({
		mutationFn: (s: Submission) => replay(s),
		onSuccess: (_, submission) => {
			void invalidateDeliveryViews(qc, submission.projectId);
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
		if (m.isPending) return;
		/* istanbul ignore else -- @preserve */
		if (!o) {
			m.reset();
			setReason("");
			setInvalid(null);
		}
		onOpenChange(o);
	};
	const onReasonChange = (value: string) => {
		setReason(value);
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
		m.mutate({ target: snapshot, reason: trimmed, projectId });
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
										<OutcomeRow
											key={r.to}
											entry={r}
											projectId={
												submitted?.projectId ??
												/* istanbul ignore next -- @preserve */ projectId
											}
										/>
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
										<OutcomeRow
											key={r.to}
											entry={r}
											projectId={
												submitted?.projectId ??
												/* istanbul ignore next -- @preserve */ projectId
											}
										/>
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
						<FormField htmlFor="replay-reason" label="Reason">
							<Textarea
								id="replay-reason"
								value={reason}
								onChange={(e) => onReasonChange(e.target.value)}
								aria-invalid={invalid !== null}
							/>
							{invalid && <p className="text-sm text-failure">{invalid}</p>}
						</FormField>
						{m.error && (
							<p className="text-sm text-failure">{errorText(m.error)}</p>
						)}
						<DialogFooter>
							<Button
								variant="outline"
								disabled={m.isPending}
								onClick={() => close(false)}
							>
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
