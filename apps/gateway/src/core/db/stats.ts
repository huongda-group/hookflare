import { eq, min, sql } from "drizzle-orm";
import type { Db } from "../../deps";
import { statsHourly, webhookEvents } from "./schema";

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
