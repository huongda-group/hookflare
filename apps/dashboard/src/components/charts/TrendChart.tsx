import type { StatsRange, TrendPoint } from "@hookflare/shared";
import {
	CartesianGrid,
	Legend,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { groupByDay } from "@/lib/time";

/**
 * The existing received/delivered/failed series (spec §8.3). Strokes use Task 1
 * status tokens, and the failed series is dashed so failure never depends on
 * color alone (spec §11). A text/table summary accompanies the figure for
 * screen readers and non-visual inspection.
 */
export function TrendChart({
	points,
	range,
}: {
	points: TrendPoint[];
	range: StatsRange;
}) {
	const daily = range !== "24h";
	const data = daily ? groupByDay(points) : points;
	const received = data.reduce((n, p) => n + p.received, 0);
	const delivered = data.reduce((n, p) => n + p.delivered, 0);
	const failed = data.reduce((n, p) => n + p.failed, 0);
	const fmt = (ms: number) =>
		new Date(ms).toLocaleString(
			"en-GB",
			daily
				? { day: "2-digit", month: "short" }
				: { hour: "2-digit", minute: "2-digit", timeZone: "UTC" },
		);
	return (
		<figure aria-label="Event trend" className="w-full">
			<div className="h-44 w-full sm:h-52">
				<ResponsiveContainer>
					<LineChart data={data}>
						<CartesianGrid strokeDasharray="3 3" />
						<XAxis dataKey="hour" tickFormatter={fmt} />
						<YAxis allowDecimals={false} />
						<Tooltip labelFormatter={(v) => fmt(Number(v))} />
						<Legend />
						<Line
							type="monotone"
							dataKey="received"
							name="Received"
							stroke="var(--action)"
							dot={false}
						/>
						<Line
							type="monotone"
							dataKey="delivered"
							name="Delivered"
							stroke="var(--success)"
							dot={false}
						/>
						<Line
							type="monotone"
							dataKey="failed"
							name="Failed"
							stroke="var(--failure)"
							strokeDasharray="5 3"
							dot={false}
						/>
					</LineChart>
				</ResponsiveContainer>
			</div>
			<figcaption className="sr-only">
				{received} events received, {delivered} deliveries completed, {failed}{" "}
				failed across {data.length} {data.length === 1 ? "point" : "points"}.
			</figcaption>
			<p className="mt-2 text-xs text-muted-foreground">
				{daily
					? "Daily traffic rollups · local time"
					: "Hourly traffic rollups · UTC"}
			</p>
			<details className="mt-2 text-sm">
				<summary className="cursor-pointer text-action underline underline-offset-2">
					Trend data table
				</summary>
				<section
					aria-label="Traffic trend data"
					className="mt-2 overflow-x-auto rounded-lg border border-border"
				>
					<table aria-label="Traffic trend" className="w-full text-sm">
						<thead>
							<tr className="border-b border-border text-left">
								<th scope="col" className="px-3 py-2 font-medium">
									Time
								</th>
								<th scope="col" className="px-3 py-2 font-medium">
									Received
								</th>
								<th scope="col" className="px-3 py-2 font-medium">
									Delivered
								</th>
								<th scope="col" className="px-3 py-2 font-medium">
									Failed
								</th>
							</tr>
						</thead>
						<tbody>
							{data.map((p) => (
								<tr
									key={p.hour}
									className="border-b border-border last:border-0"
								>
									<td className="px-3 py-1.5 whitespace-nowrap">
										{fmt(p.hour)}
									</td>
									<td className="px-3 py-1.5 tabular-nums">{p.received}</td>
									<td className="px-3 py-1.5 tabular-nums">{p.delivered}</td>
									<td className="px-3 py-1.5 tabular-nums">{p.failed}</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			</details>
		</figure>
	);
}
