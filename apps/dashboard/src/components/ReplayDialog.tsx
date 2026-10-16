import type { BulkReplayResult, ReplayResult } from "@hookflare/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { api } from "@/lib/api";
import { errorText } from "@/lib/forms";
import { qk } from "@/lib/queries/keys";

export type ReplayTarget =
	| { kind: "event"; eventId: string }
	| { kind: "bulk"; deliveryIds: string[] };
type Outcome = {
	replayed: { from: string; to: string; enqueued: boolean }[];
	skipped: { delivery_id: string; reason: string }[];
};

async function replay(target: ReplayTarget, reason: string): Promise<Outcome> {
	if (target.kind === "event") {
		const r = await api.post<ReplayResult>(`/events/${target.eventId}/replay`, {
			reason,
		});
		return {
			replayed: [
				{ from: target.eventId, to: r.delivery_id, enqueued: r.enqueued },
			],
			skipped: [],
		};
	}
	const r = await api.post<BulkReplayResult>("/failures/replay", {
		delivery_ids: target.deliveryIds,
		reason,
	});
	return {
		replayed: r.replayed.map((x) => ({
			from: x.delivery_id,
			to: x.new_delivery_id,
			enqueued: x.enqueued,
		})),
		skipped: r.skipped,
	};
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
	const [invalid, setInvalid] = useState(false);
	const count = target.kind === "event" ? 1 : target.deliveryIds.length;
	const m = useMutation({
		mutationFn: () => replay(target, reason.trim()),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: qk.events.all });
			void qc.invalidateQueries({ queryKey: qk.failures.all });
			onDone?.();
		},
	});
	const close = (o: boolean) => {
		if (!o) {
			m.reset();
			setReason("");
			setInvalid(false);
		}
		onOpenChange(o);
	};
	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						Replay {count === 1 ? "delivery" : `${count} deliveries`}
					</DialogTitle>
					<DialogDescription>
						Each replay creates a new delivery; history is never changed.
					</DialogDescription>
				</DialogHeader>
				{m.data ? (
					<div className="space-y-3 text-sm">
						{m.data.replayed.length > 0 && (
							<ul>
								{m.data.replayed.map((r) => (
									<li key={r.to}>
										{r.from} → <span className="font-mono">{r.to}</span>
										{!r.enqueued && (
											<span className="ml-2 text-amber-800">
												Saved but not queued yet — the reconciler enqueues it
												within a minute.
											</span>
										)}
									</li>
								))}
							</ul>
						)}
						{m.data.skipped.length > 0 && (
							<div>
								<p className="font-medium">Skipped</p>
								<ul>
									{m.data.skipped.map((s) => (
										<li key={s.delivery_id}>
											{s.delivery_id}: {s.reason}
										</li>
									))}
								</ul>
							</div>
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
							maxLength={500}
							value={reason}
							onChange={(e) => setReason(e.target.value)}
							aria-invalid={invalid}
						/>
						{invalid && (
							<p className="text-sm text-red-700">
								A reason is required (1–500 characters).
							</p>
						)}
						{m.error && (
							<p className="text-sm text-red-700">{errorText(m.error)}</p>
						)}
						<DialogFooter>
							<Button variant="outline" onClick={() => close(false)}>
								Cancel
							</Button>
							<Button
								disabled={m.isPending}
								onClick={() => {
									if (!reason.trim()) return setInvalid(true);
									setInvalid(false);
									m.mutate();
								}}
							>
								Replay {count}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
