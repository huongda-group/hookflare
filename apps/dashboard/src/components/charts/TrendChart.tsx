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

export function TrendChart({
	points,
	range,
}: {
	points: TrendPoint[];
	range: StatsRange;
}) {
	const daily = range !== "24h";
	const data = daily ? groupByDay(points) : points;
	const fmt = (ms: number) =>
		new Date(ms).toLocaleString(
			"en-GB",
			daily
				? { day: "2-digit", month: "short" }
				: { hour: "2-digit", minute: "2-digit" },
		);
	return (
		<div className="h-64 w-full" aria-label="Event trend">
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
						stroke="#525252"
						dot={false}
					/>
					<Line
						type="monotone"
						dataKey="delivered"
						stroke="#16a34a"
						dot={false}
					/>
					<Line type="monotone" dataKey="failed" stroke="#dc2626" dot={false} />
				</LineChart>
			</ResponsiveContainer>
		</div>
	);
}
