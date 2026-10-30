import {
	type EventSummary,
	type Page,
	STATS_RANGES,
	type StatsRange,
} from "@hookflare/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { z } from "zod";
import { TrendChart } from "@/components/charts/TrendChart";
import { DataState } from "@/components/DataState";
import { OverviewAttention } from "@/components/OverviewAttention";
import { ProjectSelect } from "@/components/ProjectSelect";
import { RecentEventsTable } from "@/components/RecentEventsTable";
import { TimeText } from "@/components/TimeText";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { qk } from "@/lib/queries/keys";
import { useOverview } from "@/lib/queries/overview";

export const overviewSearch = z.object({
	project_id: z.string().optional().catch(undefined),
	range: z.enum(STATS_RANGES).default("24h").catch("24h"),
});

function Tile({
	label,
	value,
	sub,
	tone,
}: {
	label: string;
	value: string;
	sub?: ReactNode;
	tone?: "bad" | "warn";
}) {
	return (
		<div
			data-tile
			className="min-w-0 border-r border-border px-4 py-5 last:border-r-0 max-md:nth-[2n]:border-r-0 max-md:nth-[-n+2]:border-b lg:px-6"
		>
			<div className="mb-2 text-xs text-muted-foreground">{label}</div>
			<div
				className={
					tone === "bad"
						? "text-2xl font-semibold tabular-nums text-failure"
						: tone === "warn"
							? "text-2xl font-semibold tabular-nums text-warning"
							: "text-2xl font-semibold tabular-nums"
				}
			>
				{value}
			</div>
			{sub}
		</div>
	);
}

const pct = (r: number | null) =>
	r === null ? "—" : `${(r * 100).toFixed(1)}%`;

/** Shared by `/` and the project detail page (DESIGN.md §4.2). */
export function OverviewContent({
	projectId,
	range,
	onRangeChange,
}: {
	projectId?: string;
	range: StatsRange;
	onRangeChange: (r: StatsRange) => void;
}) {
	const o = useOverview({ project_id: projectId, range });
	const recent = useQuery({
		queryKey: qk.events.list({ project_id: projectId, limit: 10 }),
		queryFn: () =>
			api.get<Page<EventSummary>>("/events", {
				project_id: projectId,
				limit: 10,
			}),
		refetchInterval: 15_000,
		refetchIntervalInBackground: false,
	});
	const [refreshing, setRefreshing] = useState(false);
	const refresh = async () => {
		if (refreshing) return;
		setRefreshing(true);
		try {
			await Promise.all([o.refetch(), recent.refetch()]);
		} finally {
			setRefreshing(false);
		}
	};
	const totals = o.data?.totals;
	const hasActivity =
		o.data !== undefined &&
		totals !== undefined &&
		(totals.received > 0 ||
			totals.delivered > 0 ||
			o.data.trend.some((p) => p.received > 0 || p.delivered > 0));
	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">
					Your webhook traffic, with the signal up front.
				</p>
				<button
					type="button"
					onClick={() => void refresh()}
					disabled={refreshing || !o.data}
					className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border bg-card px-3 text-xs font-medium hover:bg-accent disabled:opacity-50"
				>
					<RefreshCw aria-hidden="true" className="size-4" />
					{refreshing ? "Refreshing…" : "Refresh"}
				</button>
			</div>
			{o.data && <OverviewAttention overview={o.data} projectId={projectId} />}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 id="overview-reporting" className="text-base font-semibold">
					Delivery performance
				</h2>
				<Tabs
					value={range}
					onValueChange={(v) => onRangeChange(v as StatsRange)}
					aria-label="Reporting period"
				>
					<TabsList>
						{STATS_RANGES.map((r) => (
							<TabsTrigger key={r} value={r}>
								{r}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
			</div>
			<DataState
				pending={o.isPending}
				error={o.isError && !o.data ? o.error : null}
				hasData={o.data !== undefined}
				retrying={o.isRefetching}
				onRetry={() => void o.refetch()}
			>
				{o.data && (
					<div className="overflow-hidden rounded-[10px] border border-border bg-card">
						<section aria-label="Historical delivery reporting">
							<div className="grid grid-cols-2 border-b border-border lg:grid-cols-4">
								<Tile
									label="Events received"
									value={o.data.totals.received.toLocaleString("en-US")}
								/>
								<Tile
									label="Deliveries completed"
									value={o.data.totals.delivered.toLocaleString("en-US")}
								/>
								<Tile
									label="Delivery success rate"
									value={pct(o.data.totals.success_rate)}
								/>
								<Tile
									label="Terminal failures"
									value={String(
										o.data.totals.failed_final + o.data.totals.dead,
									)}
									tone={
										o.data.totals.failed_final + o.data.totals.dead
											? "bad"
											: undefined
									}
									sub={
										<div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
											<span>
												Failed final{" "}
												<span className="font-medium tabular-nums text-foreground">
													{o.data.totals.failed_final}
												</span>
											</span>
											<span>
												Dead letter{" "}
												<span className="font-medium tabular-nums text-foreground">
													{o.data.totals.dead}
												</span>
											</span>
										</div>
									}
								/>
							</div>
							<p className="px-5 py-3 text-xs text-muted-foreground">
								Totals refresh on a five-minute rollup. Queried at{" "}
								<TimeText ms={o.data.generated_at} /> (API response generation
								time, not the last rollup execution).
							</p>
						</section>
						<section
							aria-labelledby="overview-traffic"
							className="border-t border-border px-5 py-5"
						>
							<h2 id="overview-traffic" className="mb-2 font-semibold">
								Traffic over time
							</h2>
							{hasActivity ? (
								<TrendChart points={o.data.trend} range={range} />
							) : (
								<p className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
									No events received in this reporting range. Once sources start
									delivering, received, completed, and failed traffic appears
									here.
								</p>
							)}
						</section>
						<section
							aria-labelledby="overview-live"
							className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/20 px-5 py-4"
						>
							<h2 id="overview-live" className="mb-2 font-semibold">
								Current delivery states
							</h2>
							<p className="mb-2 text-xs text-muted-foreground">
								Current delivery counts are queried separately and are
								independent of the selected reporting period.
							</p>
							<div className="flex flex-wrap gap-x-6 gap-y-2">
								<Tile
									label="Pending"
									value={String(
										o.data.live.pending +
											o.data.live.queued +
											o.data.live.in_flight,
									)}
								/>
								<Tile
									label="Retrying"
									value={String(o.data.live.retrying)}
									tone={o.data.live.retrying ? "warn" : undefined}
								/>
								<Tile label="Paused" value={String(o.data.live.paused)} />
							</div>
							<p className="mt-2 text-xs text-muted-foreground">
								Pending groups pending, queued, and in flight deliveries waiting
								to send. Retrying and paused deliveries are listed separately.
							</p>
						</section>
					</div>
				)}
			</DataState>
			<section aria-labelledby="overview-recent">
				<h2 id="overview-recent" className="mb-2 font-semibold">
					Recent events
				</h2>
				<DataState
					pending={recent.isPending}
					error={recent.isError && !recent.data ? recent.error : null}
					hasData={recent.data !== undefined}
					retrying={recent.isRefetching}
					onRetry={() => void recent.refetch()}
				>
					{recent.data &&
						(recent.data.data.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								No events received yet.
							</p>
						) : (
							<RecentEventsTable events={recent.data.data} />
						))}
				</DataState>
				<p className="mt-2 text-sm">
					<Link
						to="/events"
						search={projectId ? { project_id: projectId } : {}}
						className="underline"
					>
						View all events
					</Link>
				</p>
			</section>
		</div>
	);
}

export function OverviewPage({
	search,
	setSearch,
}: {
	search: z.infer<typeof overviewSearch>;
	setSearch: (s: Partial<z.infer<typeof overviewSearch>>) => void;
}) {
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-semibold">Overview</h1>
				<ProjectSelect
					value={search.project_id}
					onChange={(project_id) => setSearch({ project_id })}
				/>
			</div>
			<OverviewContent
				projectId={search.project_id}
				range={search.range}
				onRangeChange={(range) => setSearch({ range })}
			/>
		</div>
	);
}
