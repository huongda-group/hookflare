import type { Failure, Page } from "@hookflare/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { CursorTable } from "@/components/CursorTable";
import { DestinationSelect } from "@/components/DestinationSelect";
import { IdText } from "@/components/IdText";
import { ProjectSelect } from "@/components/ProjectSelect";
import { ReplayDialog } from "@/components/ReplayDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { TimeRangeFilter } from "@/components/TimeRangeFilter";
import { TimeText } from "@/components/TimeText";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import { qk } from "@/lib/queries/keys";

export const failuresSearch = z.object({
	tab: z.enum(["failed_final", "dead"]).default("dead").catch("dead"),
	project_id: z.string().optional().catch(undefined),
	destination_id: z.string().optional().catch(undefined),
	from: z.coerce.number().optional().catch(undefined),
	to: z.coerce.number().optional().catch(undefined),
	unresolved: z.boolean().default(true).catch(true),
});
export type FailuresSearch = z.infer<typeof failuresSearch>;

const MAX_BULK = 100;

export function FailuresPage({
	search,
	setSearch,
}: {
	search: FailuresSearch;
	setSearch: (s: Partial<FailuresSearch>) => void;
}) {
	const canReplay = useCan("deliveries.replay");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [replaying, setReplaying] = useState(false);
	const { tab, ...filters } = search;
	const q = { ...filters, status: [tab] };
	const query = useInfiniteQuery({
		queryKey: qk.failures.list(q),
		queryFn: ({ pageParam }) =>
			api.get<Page<Failure>>("/failures", {
				...q,
				limit: 50,
				cursor: pageParam,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});
	const set = (s: Partial<FailuresSearch>) => {
		setSelected(new Set());
		setSearch(s);
	};
	const loadedRows = query.data?.pages.flatMap((p) => p.data) ?? [];
	const eventsByDelivery = Object.fromEntries(
		loadedRows
			.filter((f) => selected.has(f.id))
			.map((f) => [f.id, f.event_id] as const),
	);
	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h1 className="text-xl font-semibold">Failures</h1>
				{canReplay && (
					<Button
						disabled={selected.size === 0}
						onClick={() => setReplaying(true)}
					>
						Replay selected ({selected.size})
					</Button>
				)}
			</div>
			<Tabs
				value={tab}
				onValueChange={(v) => set({ tab: v as FailuresSearch["tab"] })}
			>
				<TabsList>
					<TabsTrigger value="failed_final">Failed Final</TabsTrigger>
					<TabsTrigger value="dead">Dead Letter</TabsTrigger>
				</TabsList>
			</Tabs>
			<div className="flex flex-wrap items-center gap-4">
				<ProjectSelect
					value={search.project_id}
					onChange={(project_id) =>
						// A destination belongs to one project; keep the pair consistent.
						set({ project_id, destination_id: undefined })
					}
				/>
				<DestinationSelect
					projectId={search.project_id}
					value={search.destination_id}
					onChange={(destination_id) => set({ destination_id })}
				/>
				<div>
					<div className="flex items-center gap-2">
						<Checkbox
							id="unresolved"
							checked={search.unresolved}
							onCheckedChange={(v) => set({ unresolved: v === true })}
							aria-describedby="unresolved-hint"
						/>
						<Label htmlFor="unresolved">
							Unresolved only (no successful replay)
						</Label>
					</div>
					<p id="unresolved-hint" className="mt-1 text-xs text-muted-foreground">
						Shows only failures with no successful replay.
					</p>
				</div>
			</div>
			<TimeRangeFilter
				from={search.from}
				to={search.to}
				onChange={(r) => set(r)}
			/>
			{canReplay && (
				<p className="text-xs text-muted-foreground">
					Select up to {MAX_BULK} rows per bulk replay.
				</p>
			)}
			{canReplay && selected.size > 0 && (
				<div
					role="status"
					className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm"
				>
					<p>
						{selected.size} of up to {MAX_BULK} selected. Select loaded covers
						only loaded rows — failures on pages you have not loaded are never
						included.
					</p>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setSelected(new Set())}
					>
						Clear selection
					</Button>
				</div>
			)}
			<CursorTable<Failure>
				query={query}
				rowKey={(f) => f.id}
				empty={
					tab === "dead"
						? "The dead letter queue is empty."
						: "No failed deliveries."
				}
				selection={
					canReplay
						? { selected, onChange: setSelected, max: MAX_BULK }
						: undefined
				}
				columns={[
					{ header: "Delivery", cell: (f) => <IdText id={f.id} /> },
					{
						header: "Event",
						cell: (f) => (
							<Link
								to="/events/$eventId"
								params={{ eventId: f.event_id }}
								className="font-mono text-xs underline"
							>
								{f.event_id}
							</Link>
						),
					},
					{
						header: "Destination",
						cell: (f) => <IdText id={f.destination_id} />,
					},
					{ header: "Attempts", cell: (f) => f.attempt_count },
					{
						header: "Last error",
						cell: (f) =>
							f.last_http_status
								? `HTTP ${f.last_http_status}`
								: (f.last_error ?? "—"),
					},
					{
						header: "Completed",
						cell: (f) => <TimeText ms={f.completed_at} />,
					},
					{
						header: "Latest replay",
						cell: (f) =>
							f.latest_replay ? (
								<span className="inline-flex items-center gap-1">
									<IdText id={f.latest_replay.id} />
									<StatusBadge status={f.latest_replay.status} />
								</span>
							) : (
								"—"
							),
					},
				]}
			/>
			<ReplayDialog
				open={replaying}
				onOpenChange={setReplaying}
				target={{
					kind: "bulk",
					deliveryIds: [...selected],
					eventsByDelivery,
				}}
				onDone={() => setSelected(new Set())}
			/>
		</div>
	);
}
