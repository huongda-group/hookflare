import {
	type EventSummary,
	type Page,
	STATS_RANGES,
	type StatsRange,
} from "@hookflare/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { z } from "zod";
import { TrendChart } from "@/components/charts/TrendChart";
import { IdText } from "@/components/IdText";
import { ProjectSelect } from "@/components/ProjectSelect";
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
	tone,
}: {
	label: string;
	value: string;
	tone?: "bad" | "warn";
}) {
	return (
		<div data-tile className="rounded border p-4">
			<div className="text-xs uppercase text-neutral-500">{label}</div>
			<div
				className={
					tone === "bad"
						? "text-2xl font-semibold text-red-700"
						: tone === "warn"
							? "text-2xl font-semibold text-amber-700"
							: "text-2xl font-semibold"
				}
			>
				{value}
			</div>
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
			{o.data && (
				<>
					<div className="grid grid-cols-4 gap-3">
						<Tile label="Received" value={String(o.data.totals.received)} />
						<Tile label="Delivered" value={String(o.data.totals.delivered)} />
						<Tile
							label="Success rate"
							value={pct(o.data.totals.success_rate)}
						/>
						<Tile
							label="Failed final"
							value={String(o.data.totals.failed_final)}
							tone={o.data.totals.failed_final ? "bad" : undefined}
						/>
						<Tile
							label="Dead"
							value={String(o.data.totals.dead)}
							tone={o.data.totals.dead ? "bad" : undefined}
						/>
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
					<p className="text-xs text-neutral-500">
						Totals are updated every 5 minutes (as of{" "}
						<TimeText ms={o.data.generated_at} />
						). Pending, Retrying, and Paused are live.
					</p>
					<TrendChart points={o.data.trend} range={range} />
					<section>
						<h2 className="mb-2 font-semibold">Failing destinations</h2>
						{o.data.failing_destinations.length === 0 ? (
							<p className="text-sm text-neutral-500">
								No failures in this range.
							</p>
						) : (
							<ul className="space-y-1 text-sm">
								{o.data.failing_destinations.map((f) => (
									<li key={f.destination_id} className="flex gap-3">
										<Link
											to="/failures"
											search={{ destination_id: f.destination_id }}
											className="underline"
										>
											{f.name ?? f.destination_id}
										</Link>
										<span className="text-red-700">{f.failed} failed</span>
										<span className="text-neutral-500">
											{f.delivered} delivered
										</span>
									</li>
								))}
							</ul>
						)}
					</section>
				</>
			)}
			<section>
				<h2 className="mb-2 font-semibold">Recent events</h2>
				<ul className="space-y-1 text-sm">
					{recent.data?.data.map((e) => (
						<li key={e.id} className="flex items-center gap-3">
							<Link
								to="/events/$eventId"
								params={{ eventId: e.id }}
								className="font-mono text-xs underline"
							>
								{e.id}
							</Link>
							<IdText id={e.source_id} />
							{e.latest_delivery && (
								<StatusBadge status={e.latest_delivery.status} />
							)}
							<TimeText ms={e.received_at} />
						</li>
					))}
				</ul>
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
