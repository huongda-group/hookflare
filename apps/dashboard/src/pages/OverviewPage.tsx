import {
	type EventSummary,
	type Page,
	STATS_RANGES,
	type StatsRange,
} from "@hookflare/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { z } from "zod";
import { TrendChart } from "@/components/charts/TrendChart";
import { DataState } from "@/components/DataState";
import { ProjectSelect } from "@/components/ProjectSelect";
import { ResourceLabel } from "@/components/ResourceLabel";
import { StatusBadge } from "@/components/StatusBadge";
import { TimeText } from "@/components/TimeText";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
			className="rounded-lg border border-border bg-card p-4"
		>
			<div className="text-xs uppercase text-muted-foreground">{label}</div>
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
	const totals = o.data?.totals;
	const hasActivity =
		o.data !== undefined &&
		totals !== undefined &&
		(totals.received > 0 ||
			totals.delivered > 0 ||
			o.data.trend.some((p) => p.received > 0 || p.delivered > 0));
	return (
		<div className="space-y-6">
			{o.data && o.data.open_alerts.count > 0 && (
				<Alert variant="destructive">
					<AlertDescription>
						<Link
							to="/alerts"
							search={{
								status: "open",
								...(projectId ? { project_id: projectId } : {}),
							}}
							className="underline"
						>
							{o.data.open_alerts.count} open{" "}
							{o.data.open_alerts.count === 1 ? "alert" : "alerts"}
						</Link>
					</AlertDescription>
				</Alert>
			)}
			<Tabs value={range} onValueChange={(v) => onRangeChange(v as StatsRange)}>
				<TabsList>
					{STATS_RANGES.map((r) => (
						<TabsTrigger key={r} value={r}>
							{r}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
			<DataState
				pending={o.isPending}
				error={o.isError && !o.data ? o.error : null}
				hasData={o.data !== undefined}
				retrying={o.isRefetching}
				onRetry={() => void o.refetch()}
			>
				{o.data && (
					<div className="space-y-6">
						<section aria-labelledby="overview-reporting">
							<h2 id="overview-reporting" className="mb-2 font-semibold">
								Reporting
							</h2>
							<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
								<Tile
									label="Events received"
									value={String(o.data.totals.received)}
								/>
								<Tile
									label="Deliveries completed"
									value={String(o.data.totals.delivered)}
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
							<p className="mt-2 text-xs text-muted-foreground">
								Totals refresh on a five-minute rollup. Queried at{" "}
								<TimeText ms={o.data.generated_at} /> (API response
								generation time, not the last rollup execution).
							</p>
						</section>
						<section aria-labelledby="overview-traffic">
							<h2 id="overview-traffic" className="mb-2 font-semibold">
								Traffic
							</h2>
							{hasActivity ? (
								<TrendChart points={o.data.trend} range={range} />
							) : (
								<p className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
									No events received in this reporting range. Once sources
									start delivering, received, completed, and failed traffic
									appears here.
								</p>
							)}
						</section>
						<section aria-labelledby="overview-live">
							<h2 id="overview-live" className="mb-2 font-semibold">
								Current delivery states
							</h2>
							<p className="mb-2 text-xs text-muted-foreground">
								Current delivery counts are queried separately and are
								independent of the selected reporting period.
							</p>
							<div className="grid grid-cols-3 gap-3">
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
								Pending groups pending, queued, and in flight deliveries
								waiting to send. Retrying and paused deliveries are listed
								separately.
							</p>
						</section>
						<section aria-labelledby="overview-failing">
							<h2 id="overview-failing" className="mb-2 font-semibold">
								Failing destinations
							</h2>
							{o.data.failing_destinations.length === 0 ? (
								<p className="text-sm text-muted-foreground">
									No failures in this range.
								</p>
							) : (
								<ul className="space-y-1 text-sm">
									{o.data.failing_destinations.map((f) => (
										<li key={f.destination_id} className="flex gap-3">
											<Link
												to="/failures"
												search={{
													destination_id: f.destination_id,
													...(projectId ? { project_id: projectId } : {}),
													from: o.data.from,
													to: o.data.to,
												}}
												className="underline"
											>
												{f.name ?? f.destination_id}
											</Link>
											<span className="text-failure">{f.failed} failed</span>
											<span className="text-muted-foreground">
												{f.delivered} delivered
											</span>
										</li>
									))}
								</ul>
							)}
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
							<ul className="space-y-1 text-sm">
								{recent.data.data.map((e) => (
									<li key={e.id} className="flex flex-wrap items-center gap-3">
										<Link
											to="/events/$eventId"
											params={{ eventId: e.id }}
											className="font-mono text-xs underline"
										>
											{e.id}
										</Link>
										{e.provider_event_id && (
											<span className="font-mono text-xs text-muted-foreground">
												{e.provider_event_id}
											</span>
										)}
										<ResourceLabel
											kind="source"
											id={e.source_id}
											projectId={e.project_id}
										/>
										{e.latest_delivery && (
											<>
												<ResourceLabel
													kind="destination"
													id={e.latest_delivery.destination_id}
													projectId={e.project_id}
												/>
												<StatusBadge status={e.latest_delivery.status} />
												{e.latest_delivery.last_http_status && (
													<span className="text-xs text-muted-foreground">
														HTTP {e.latest_delivery.last_http_status}
													</span>
												)}
											</>
										)}
										<TimeText ms={e.received_at} />
									</li>
								))}
							</ul>
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
			<div className="flex items-center justify-between">
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
