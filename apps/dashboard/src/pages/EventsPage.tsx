import { DELIVERY_STATUS_VALUES, type EventSummary } from "@hookflare/shared";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { CursorTable } from "@/components/CursorTable";
import { IdText } from "@/components/IdText";
import { ProjectSelect } from "@/components/ProjectSelect";
import { StatusBadge } from "@/components/StatusBadge";
import { TimeText } from "@/components/TimeText";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEventsPage } from "@/lib/queries/events";
import { formatBytes } from "@/lib/time";

export const eventsSearch = z.object({
	project_id: z.string().optional().catch(undefined),
	source_id: z.string().optional().catch(undefined),
	destination_id: z.string().optional().catch(undefined),
	status: z.array(z.enum(DELIVERY_STATUS_VALUES)).optional().catch(undefined),
	http_status: z.coerce
		.number()
		.int()
		.min(100)
		.max(599)
		.optional()
		.catch(undefined),
	provider_event_id: z.string().optional().catch(undefined),
	from: z.coerce.number().optional().catch(undefined),
	to: z.coerce.number().optional().catch(undefined),
});
export type EventsSearch = z.infer<typeof eventsSearch>;

export function EventsPage({
	search,
	setSearch,
}: {
	search: EventsSearch;
	setSearch: (s: Partial<EventsSearch>) => void;
}) {
	const navigate = useNavigate();
	const query = useEventsPage(search);
	const [text, setText] = useState(search.provider_event_id ?? "");
	const [hint, setHint] = useState<string | null>(null);
	const onSearch = () => {
		const v = text.trim();
		setHint(null);
		if (!v) return setSearch({ provider_event_id: undefined });
		if (v.startsWith("evt_"))
			return void navigate({ to: "/events/$eventId", params: { eventId: v } });
		if (!search.source_id)
			return setHint(
				"Choose a source (Source ID filter) to search by provider event ID.",
			);
		setSearch({ provider_event_id: v });
	};
	const toggleStatus = (s: (typeof DELIVERY_STATUS_VALUES)[number]) => {
		const cur = new Set(search.status ?? []);
		if (cur.has(s)) cur.delete(s);
		else cur.add(s);
		setSearch({ status: cur.size ? [...cur] : undefined });
	};
	return (
		<div className="space-y-4">
			<h1 className="text-xl font-semibold">Events</h1>
			<div className="flex flex-wrap items-end gap-3">
				<ProjectSelect
					value={search.project_id}
					onChange={(project_id) => setSearch({ project_id })}
				/>
				<div>
					<Label htmlFor="f-source">Source ID</Label>
					<Input
						id="f-source"
						className="w-44"
						// Keyed on the URL value so back/forward refreshes the uncontrolled input.
						key={`source_id-${search.source_id ?? ""}`}
						defaultValue={search.source_id}
						onBlur={(e) =>
							setSearch({ source_id: e.target.value || undefined })
						}
					/>
				</div>
				<div>
					<Label htmlFor="f-dest">Destination ID</Label>
					<Input
						id="f-dest"
						className="w-44"
						// Keyed on the URL value so back/forward refreshes the uncontrolled input.
						key={`destination_id-${search.destination_id ?? ""}`}
						defaultValue={search.destination_id}
						onBlur={(e) =>
							setSearch({ destination_id: e.target.value || undefined })
						}
					/>
				</div>
				<div>
					<Label htmlFor="f-http">HTTP status</Label>
					<Input
						id="f-http"
						type="number"
						className="w-24"
						// Keyed on the URL value so back/forward refreshes the uncontrolled input.
						key={`http_status-${search.http_status ?? ""}`}
						defaultValue={search.http_status}
						onBlur={(e) =>
							setSearch({
								http_status: e.target.value
									? Number(e.target.value)
									: undefined,
							})
						}
					/>
				</div>
				<div>
					<Label htmlFor="f-from">From</Label>
					<Input
						id="f-from"
						type="datetime-local"
						// Keyed on the URL value so back/forward refreshes the uncontrolled input.
						key={`from-${search.from ?? ""}`}
						defaultValue={search.from ? toLocalInput(search.from) : ""}
						onBlur={(e) =>
							setSearch({
								from: e.target.value
									? new Date(e.target.value).getTime()
									: undefined,
							})
						}
					/>
				</div>
				<div>
					<Label htmlFor="f-to">To</Label>
					<Input
						id="f-to"
						type="datetime-local"
						// Keyed on the URL value so back/forward refreshes the uncontrolled input.
						key={`to-${search.to ?? ""}`}
						defaultValue={search.to ? toLocalInput(search.to) : ""}
						onBlur={(e) =>
							setSearch({
								to: e.target.value
									? new Date(e.target.value).getTime()
									: undefined,
							})
						}
					/>
				</div>
				<div className="flex-1">
					<Label htmlFor="f-q">Search</Label>
					<Input
						id="f-q"
						placeholder="evt_… or provider event ID"
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && onSearch()}
					/>
				</div>
			</div>
			<fieldset className="flex flex-wrap gap-2" aria-label="Status">
				{DELIVERY_STATUS_VALUES.map((s) => (
					<button
						key={s}
						type="button"
						aria-pressed={search.status?.includes(s) ?? false}
						className={
							search.status?.includes(s)
								? "rounded border border-neutral-900 px-2 py-0.5 text-xs"
								: "rounded border px-2 py-0.5 text-xs text-neutral-500"
						}
						onClick={() => toggleStatus(s)}
					>
						{s.replace("_", " ")}
					</button>
				))}
			</fieldset>
			{hint && <p className="text-sm text-amber-800">{hint}</p>}
			<CursorTable<EventSummary>
				query={query}
				rowKey={(e) => e.id}
				empty="No events match these filters."
				onRowClick={(e) =>
					void navigate({ to: "/events/$eventId", params: { eventId: e.id } })
				}
				columns={[
					{ header: "Received", cell: (e) => <TimeText ms={e.received_at} /> },
					{ header: "Event ID", cell: (e) => <IdText id={e.id} /> },
					{
						header: "Provider ID",
						cell: (e) => (
							<span className="font-mono text-xs">
								{e.provider_event_id ?? "—"}
							</span>
						),
					},
					{ header: "Source", cell: (e) => <IdText id={e.source_id} /> },
					{
						header: "Destination",
						cell: (e) =>
							e.latest_delivery ? (
								<IdText id={e.latest_delivery.destination_id} />
							) : (
								"—"
							),
					},
					{
						header: "Status",
						cell: (e) =>
							e.latest_delivery ? (
								<StatusBadge status={e.latest_delivery.status} />
							) : (
								"—"
							),
					},
					{
						header: "HTTP",
						cell: (e) =>
							e.latest_delivery?.last_http_status
								? `HTTP ${e.latest_delivery.last_http_status}`
								: "—",
					},
					{
						header: "Attempts",
						cell: (e) => e.latest_delivery?.attempt_count ?? 0,
					},
					{
						header: "Next retry",
						cell: (e) => (
							<TimeText ms={e.latest_delivery?.next_attempt_at ?? null} />
						),
					},
					{ header: "Size", cell: (e) => formatBytes(e.size_bytes) },
				]}
			/>
		</div>
	);
}

/** `datetime-local` wants local "YYYY-MM-DDTHH:mm". */
function toLocalInput(ms: number) {
	const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
	return d.toISOString().slice(0, 16);
}
