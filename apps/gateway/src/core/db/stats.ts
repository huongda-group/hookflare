import { LIVE_STATUSES, type LiveStatus } from "@hookflare/shared";
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	lt,
	min,
	type SQL,
	sql,
} from "drizzle-orm";
import type { Db } from "../../deps";
import { deliveries, destinations, statsHourly, webhookEvents } from "./schema";

export const HOUR_MS = 3_600_000;

export function floorHour(ms: number): number {
	return ms - (ms % HOUR_MS);
}

const conflictTarget = [
	statsHourly.hour,
	statsHourly.projectId,
	statsHourly.sourceId,
	statsHourly.destinationId,
];

/**
 * Recomputes one hour from scratch (spec §6): delete, then one INSERT … SELECT
 * per counter group, merged into the same row by the upsert. Run as one
 * db.batch so readers never see a half-built hour.
 */
export function rollupHourStatements(db: Db, hour: number) {
	const end = hour + HOUR_MS;
	return [
		db.delete(statsHourly).where(eq(statsHourly.hour, hour)),
		db
			.insert(statsHourly)
			.select(sql`
				SELECT ${hour}, e.project_id, e.source_id, d.destination_id, COUNT(*), 0, 0, 0, 0
				FROM webhook_events e
				JOIN deliveries d ON d.event_id = e.id AND d.kind = 'initial'
				WHERE e.received_at >= ${hour} AND e.received_at < ${end}
				GROUP BY e.project_id, e.source_id, d.destination_id`)
			.onConflictDoUpdate({
				target: conflictTarget,
				set: { received: sql`received + excluded.received` },
			}),
		db
			.insert(statsHourly)
			.select(sql`
				SELECT ${hour}, d.project_id, e.source_id, d.destination_id,
					0, SUM(d.status = 'delivered'), SUM(d.status = 'failed_final'), SUM(d.status = 'dead'), 0
				FROM deliveries d
				JOIN webhook_events e ON e.id = d.event_id
				WHERE d.status IN ('delivered', 'failed_final', 'dead')
					AND d.completed_at >= ${hour} AND d.completed_at < ${end}
				GROUP BY d.project_id, e.source_id, d.destination_id`)
			.onConflictDoUpdate({
				target: conflictTarget,
				set: {
					delivered: sql`delivered + excluded.delivered`,
					failedFinal: sql`failed_final + excluded.failed_final`,
					dead: sql`dead + excluded.dead`,
				},
			}),
		db
			.insert(statsHourly)
			.select(sql`
				SELECT ${hour}, d.project_id, e.source_id, d.destination_id, 0, 0, 0, 0, COUNT(*)
				FROM delivery_attempts a
				JOIN deliveries d ON d.id = a.delivery_id
				JOIN webhook_events e ON e.id = d.event_id
				WHERE a.started_at >= ${hour} AND a.started_at < ${end}
				GROUP BY d.project_id, e.source_id, d.destination_id`)
			.onConflictDoUpdate({
				target: conflictTarget,
				set: { attempts: sql`attempts + excluded.attempts` },
			}),
	] as const;
}

export async function oldestEventAt(db: Db): Promise<number | null> {
	const row = await db
		.select({ at: min(webhookEvents.receivedAt) })
		.from(webhookEvents)
		.get();
	return row?.at ?? null;
}

export type StatsScope = { from: number; to: number; projectId?: string };

/** `hours` whole hours ending at the end of the current hour (spec §7.1). */
export function statsWindow(now: number, hours: number) {
	const to = floorHour(now) + HOUR_MS;
	return { from: to - hours * HOUR_MS, to };
}

function scopeWhere(w: StatsScope): SQL | undefined {
	return and(
		gte(statsHourly.hour, w.from),
		lt(statsHourly.hour, w.to),
		w.projectId ? eq(statsHourly.projectId, w.projectId) : undefined,
	);
}

const sum = (column: SQL | object) =>
	sql<number>`COALESCE(SUM(${column as SQL}), 0)`.mapWith(Number);

export async function overviewTotals(db: Db, w: StatsScope) {
	const row = await db
		.select({
			received: sum(statsHourly.received),
			delivered: sum(statsHourly.delivered),
			failedFinal: sum(statsHourly.failedFinal),
			dead: sum(statsHourly.dead),
			attempts: sum(statsHourly.attempts),
		})
		.from(statsHourly)
		.where(scopeWhere(w))
		.get();
	return (
		row ?? { received: 0, delivered: 0, failedFinal: 0, dead: 0, attempts: 0 }
	);
}

export async function trendRows(db: Db, w: StatsScope) {
	return db
		.select({
			hour: statsHourly.hour,
			received: sum(statsHourly.received),
			delivered: sum(statsHourly.delivered),
			failed: sum(sql`${statsHourly.failedFinal} + ${statsHourly.dead}`),
		})
		.from(statsHourly)
		.where(scopeWhere(w))
		.groupBy(statsHourly.hour);
}

export async function failingDestinations(db: Db, w: StatsScope, limit = 5) {
	const failed = sum(sql`${statsHourly.failedFinal} + ${statsHourly.dead}`);
	return db
		.select({
			destinationId: statsHourly.destinationId,
			name: destinations.name,
			failed,
			delivered: sum(statsHourly.delivered),
		})
		.from(statsHourly)
		.leftJoin(destinations, eq(destinations.id, statsHourly.destinationId))
		.where(scopeWhere(w))
		.groupBy(statsHourly.destinationId)
		.having(sql`${failed} > 0`)
		.orderBy(desc(failed), statsHourly.destinationId)
		.limit(limit);
}

/** Read from deliveries, not stats: these are the current backlog (spec §7.1). */
export async function liveCounts(
	db: Db,
	projectId?: string,
): Promise<Record<LiveStatus, number>> {
	const rows = await db
		.select({
			status: deliveries.status,
			n: sql<number>`COUNT(*)`.mapWith(Number),
		})
		.from(deliveries)
		.where(
			and(
				inArray(deliveries.status, [...LIVE_STATUSES]),
				projectId ? eq(deliveries.projectId, projectId) : undefined,
			),
		)
		.groupBy(deliveries.status);
	const out = Object.fromEntries(LIVE_STATUSES.map((s) => [s, 0])) as Record<
		LiveStatus,
		number
	>;
	for (const r of rows) out[r.status as LiveStatus] = r.n;
	return out;
}

export type DestinationStatsRow = {
	destinationId: string;
	delivered: number;
	failed: number;
	lastDeliveryAt: number | null;
	lastHttpStatus: number | null;
	lastError: string | null;
};

/** One row per destination in scope; the "last" fields come from its newest terminal delivery. */
export async function destinationStats(
	db: Db,
	w: StatsScope,
): Promise<DestinationStatsRow[]> {
	const rows = await db.all<{
		destination_id: string;
		delivered: number;
		failed: number;
		completed_at: number | null;
		last_http_status: number | null;
		last_error: string | null;
	}>(sql`
		SELECT dst.id AS destination_id,
			COALESCE(s.delivered, 0) AS delivered,
			COALESCE(s.failed, 0) AS failed,
			l.completed_at, l.last_http_status, l.last_error
		FROM destinations dst
		LEFT JOIN (
			SELECT destination_id, SUM(delivered) AS delivered, SUM(failed_final + dead) AS failed
			FROM stats_hourly
			WHERE hour >= ${w.from} AND hour < ${w.to}
			GROUP BY destination_id
		) s ON s.destination_id = dst.id
		LEFT JOIN deliveries l ON l.id = (
			SELECT x.id FROM deliveries x
			WHERE x.destination_id = dst.id
				AND x.status IN ('delivered', 'failed_final', 'dead')
			ORDER BY x.created_at DESC, x.id DESC
			LIMIT 1
		)
		${w.projectId ? sql`WHERE dst.project_id = ${w.projectId}` : sql``}
		ORDER BY dst.id`);
	return rows.map((r) => ({
		destinationId: r.destination_id,
		delivered: Number(r.delivered),
		failed: Number(r.failed),
		lastDeliveryAt: r.completed_at,
		lastHttpStatus: r.last_http_status,
		lastError: r.last_error,
	}));
}
