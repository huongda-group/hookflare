import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, apiRaw } from "@/lib/api";
import { errorText } from "@/lib/forms";
import { formatBytes } from "@/lib/time";
import { downloadBlob, JsonViewer } from "./JsonViewer";

/**
 * Spec M4-10: one click = one fetch = one `event.payload_viewed` audit row.
 * The query never retries in the background and never refetches on mount or
 * tab switches: `retry: false`, `gcTime: 0`, `staleTime: Infinity`, fetched
 * only after an explicit Show click, retried only by an explicit Retry click.
 */
export function PayloadPanel({
	eventId,
	contentType,
	size,
	onMissing,
}: {
	eventId: string;
	contentType: string | null;
	size: number;
	/** Called once when the backend confirms the payload is gone. */
	onMissing?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const missingNotified = useRef(false);
	const payload = useQuery({
		queryKey: ["payload", eventId],
		enabled: open,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
		retry: false,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
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
	const missing =
		payload.error instanceof ApiError &&
		payload.error.code === "payload_missing";
	useEffect(() => {
		if (missing && !missingNotified.current) {
			missingNotified.current = true;
			onMissing?.();
		}
	}, [missing, onMissing]);
	if (!open) {
		return (
			<Button variant="outline" onClick={() => setOpen(true)}>
				Show payload
			</Button>
		);
	}
	if (payload.isPending)
		return (
			<p className="text-muted-foreground">
				Loading payload ({formatBytes(size)})…
			</p>
		);
	if (payload.error) {
		if (missing) {
			return <p>Payload no longer available.</p>;
		}
		return (
			<div className="space-y-2">
				<p role="alert">
					Could not load the payload ({errorText(payload.error)}).
				</p>
				<Button
					variant="outline"
					size="sm"
					disabled={payload.isFetching}
					onClick={() => void payload.refetch()}
				>
					Retry
				</Button>
			</div>
		);
	}
	const { blob, text } = payload.data;
	if (text === null) {
		return (
			<div>
				<p className="text-muted-foreground">
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
