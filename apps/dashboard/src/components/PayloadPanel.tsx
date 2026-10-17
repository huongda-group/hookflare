import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, apiRaw } from "@/lib/api";
import { errorText } from "@/lib/forms";
import { formatBytes } from "@/lib/time";
import { downloadBlob, JsonViewer } from "./JsonViewer";

/** Spec M4-10: one click = one fetch = one `event.payload_viewed` audit row. */
export function PayloadPanel({
	eventId,
	contentType,
	size,
}: {
	eventId: string;
	contentType: string | null;
	size: number;
}) {
	const [open, setOpen] = useState(false);
	const payload = useQuery({
		queryKey: ["payload", eventId],
		enabled: open,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
		queryFn: async () => {
			const res = await apiRaw(`/events/${eventId}/payload`);
			// Bytes, not text(): text() replaces invalid UTF-8, which would also
			// corrupt Download for binary bodies.
			const bytes = await res.arrayBuffer();
			const blob = new Blob([bytes], {
				type: res.headers.get("content-type") ?? contentType ?? "",
			});
			let text: string | null;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				text = null; // not UTF-8: treat as binary
			}
			return { blob, text };
		},
	});
	if (!open) {
		return (
			<Button variant="outline" onClick={() => setOpen(true)}>
				Show payload
			</Button>
		);
	}
	if (payload.isPending)
		return (
			<p className="text-neutral-500">Loading payload ({formatBytes(size)})…</p>
		);
	if (payload.error) {
		const missing =
			payload.error instanceof ApiError &&
			payload.error.code === "payload_missing";
		return (
			<p className="text-red-700">
				{missing
					? "Payload no longer available."
					: `Could not load the payload (${errorText(payload.error)}).`}
			</p>
		);
	}
	const { blob, text } = payload.data;
	if (text === null) {
		return (
			<div>
				<p className="text-neutral-500">
					Binary payload ({blob.size} bytes) — download to inspect
				</p>
				<Button
					variant="outline"
					size="sm"
					className="mt-2"
					onClick={() => downloadBlob(blob, eventId)}
				>
					Download
				</Button>
			</div>
		);
	}
	return (
		<JsonViewer
			text={text}
			contentType={contentType}
			filename={eventId}
			download={blob}
		/>
	);
}
