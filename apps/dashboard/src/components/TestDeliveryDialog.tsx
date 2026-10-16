import type { TestDelivery } from "@hookflare/shared";
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

const MAX = 64 * 1024;

export function TestDeliveryDialog({
	open,
	onOpenChange,
	destinationId,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	destinationId: string;
}) {
	const qc = useQueryClient();
	const [text, setText] = useState("");
	const [invalid, setInvalid] = useState<string | null>(null);
	const m = useMutation({
		mutationFn: (payload: unknown) =>
			api.post<
				Omit<TestDelivery, "destination_id" | "actor_email" | "started_at">
			>(
				`/destinations/${destinationId}/test`,
				payload === undefined ? {} : { payload },
			),
		onSuccess: () =>
			void qc.invalidateQueries({
				queryKey: qk.destinations.tests(destinationId),
			}),
	});
	const send = () => {
		if (new TextEncoder().encode(text).length > MAX)
			return setInvalid("Payload is larger than 64 KB.");
		let payload: unknown;
		if (text.trim()) {
			try {
				payload = JSON.parse(text);
			} catch {
				return setInvalid("Payload is not valid JSON.");
			}
		}
		setInvalid(null);
		m.mutate(payload);
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) m.reset();
				onOpenChange(o);
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Send test delivery</DialogTitle>
					<DialogDescription>
						Signed like a real delivery. Leave empty for the default test event.
					</DialogDescription>
				</DialogHeader>
				<Label htmlFor="test-payload">JSON payload (optional)</Label>
				<Textarea
					id="test-payload"
					className="font-mono"
					rows={8}
					value={text}
					onChange={(e) => setText(e.target.value)}
				/>
				{invalid && <p className="text-sm text-red-700">{invalid}</p>}
				{m.error && (
					<p className="text-sm text-red-700">{errorText(m.error)}</p>
				)}
				{m.data && (
					<div className="rounded bg-neutral-50 p-3 text-sm">
						<div>
							{m.data.http_status !== null
								? `HTTP ${m.data.http_status}`
								: m.data.error_kind}{" "}
							· {m.data.duration_ms} ms
						</div>
						{m.data.error_message && (
							<div className="text-red-700">{m.data.error_message}</div>
						)}
						{m.data.response_snippet && (
							<pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs">
								{m.data.response_snippet}
							</pre>
						)}
					</div>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Close
					</Button>
					<Button disabled={m.isPending} onClick={send}>
						Send
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
