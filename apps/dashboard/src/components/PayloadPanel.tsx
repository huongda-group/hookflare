import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, apiRaw } from "@/lib/api";
import { errorText } from "@/lib/forms";
import { formatBytes } from "@/lib/time";
import { JsonViewer } from "./JsonViewer";

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
			const res = await apiRaw(
				`/events/${eventId}/payload`,
				{},
				{ allowHtml: true },
			);
			return res.text();
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
	return (
		<JsonViewer
			text={payload.data}
			contentType={contentType}
			filename={eventId}
		/>
	);
}
