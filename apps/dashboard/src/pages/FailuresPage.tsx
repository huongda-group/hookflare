import type { Failure, Page } from "@hookflare/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { CursorTable } from "@/components/CursorTable";
import { IdText } from "@/components/IdText";
import { ProjectSelect } from "@/components/ProjectSelect";
import { ReplayDialog } from "@/components/ReplayDialog";
import { StatusBadge } from "@/components/StatusBadge";
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
					onChange={(project_id) => set({ project_id })}
				/>
				{search.destination_id && (
					<span className="text-sm">
						Destination <IdText id={search.destination_id} />{" "}
						<button
							type="button"
							className="underline"
							onClick={() => set({ destination_id: undefined })}
						>
							clear
						</button>
					</span>
				)}
				<div className="flex items-center gap-2">
					<Checkbox
						id="unresolved"
						checked={search.unresolved}
						onCheckedChange={(v) => set({ unresolved: v === true })}
					/>
					<Label htmlFor="unresolved">
						Unresolved only (no successful replay)
					</Label>
				</div>
			</div>
			{canReplay && (
				<p className="text-xs text-neutral-500">
					Select up to {MAX_BULK} rows per bulk replay.
				</p>
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
				target={{ kind: "bulk", deliveryIds: [...selected] }}
				onDone={() => setSelected(new Set())}
			/>
		</div>
	);
}
