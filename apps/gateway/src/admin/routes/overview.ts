import {
	type AlertRule,
	type Overview,
	RANGE_HOURS,
	statsQuery,
	type TrendPoint,
} from "@hookflare/shared";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { alerts } from "../../core/db/schema";
import {
	failingDestinations,
	HOUR_MS,
	liveCounts,
	overviewTotals,
	statsWindow,
	trendRows,
} from "../../core/db/stats";
import { requirePermission } from "../auth/permission";
import { readQuery } from "../http";

/** null when nothing completed: 0 % would claim every delivery failed. */
export function successRate(delivered: number, failed: number): number | null {
	const done = delivered + failed;
	return done === 0 ? null : delivered / done;
}

export function overviewRoutes() {
	const routes = new Hono<AppBindings>();

	routes.get("/", requirePermission("events.read"), async (c) => {
		const q = readQuery(c, statsQuery);
		if (!q.ok) return q.response;
		const { db, now } = c.var.deps;
		const generatedAt = now();
		const hours = RANGE_HOURS[q.value.range];
		const scope = {
			...statsWindow(generatedAt, hours),
			projectId: q.value.project_id,
		};
		const [totals, trend, failing, live, openAlerts] = await Promise.all([
			overviewTotals(db, scope),
			trendRows(db, scope),
			failingDestinations(db, scope),
			liveCounts(db, q.value.project_id),
			db
				.select({ rule: alerts.rule, n: sql<number>`COUNT(*)` })
				.from(alerts)
				.where(
					and(
						eq(alerts.status, "open"),
						// System alerts (no project) concern every project, so a
						// project-scoped overview still counts them.
						q.value.project_id
							? or(
									eq(alerts.projectId, q.value.project_id),
									isNull(alerts.projectId),
								)
							: undefined,
					),
				)
				.groupBy(alerts.rule),
		]);
		const byHour = new Map(trend.map((t) => [t.hour, t]));
		const points: TrendPoint[] = [];
		for (let h = scope.from; h < scope.to; h += HOUR_MS) {
			const t = byHour.get(h);
			points.push({
				hour: h,
				received: t?.received ?? 0,
				delivered: t?.delivered ?? 0,
				failed: t?.failed ?? 0,
			});
		}
		return c.json({
			range: q.value.range,
			from: scope.from,
			to: scope.to,
			generated_at: generatedAt,
			totals: {
				received: totals.received,
				delivered: totals.delivered,
				failed_final: totals.failedFinal,
				dead: totals.dead,
				attempts: totals.attempts,
				success_rate: successRate(
					totals.delivered,
					totals.failedFinal + totals.dead,
				),
			},
			live,
			trend: points,
			failing_destinations: failing.map((f) => ({
				destination_id: f.destinationId,
				name: f.name,
				failed: f.failed,
				delivered: f.delivered,
			})),
			open_alerts: {
				count: openAlerts.reduce((s, r) => s + r.n, 0),
				by_rule: Object.fromEntries(
					openAlerts.map((r) => [r.rule, r.n]),
				) as Partial<Record<AlertRule, number>>,
			},
		} satisfies Overview);
	});

	return routes;
}
