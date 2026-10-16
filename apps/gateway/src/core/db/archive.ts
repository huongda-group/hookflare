import type { StorageSettings } from "@hookflare/shared";
import { and, inArray, type SQL, sql } from "drizzle-orm";
import type { Db } from "../../deps";
import type { BatchItem } from "./alerts";
import { webhookEvents } from "./schema";

export const DAY_MS = 86_400_000;
const TERMINAL = sql.raw("('delivered', 'failed_final', 'dead')");
const FAILED = sql.raw("('failed_final', 'dead')");

export type Cutoffs = { hotBefore: number; failedBefore: number };

export function cutoffsFor(
	s: Pick<StorageSettings, "hot_retention_days" | "failed_retention_days">,
	now: number,
): Cutoffs {
	return {
		hotBefore: now - s.hot_retention_days * DAY_MS,
		failedBefore: now - s.failed_retention_days * DAY_MS,
	};
}

/**
 * Spec §7.3. An event with any non-terminal delivery never leaves D1; one
 * with no deliveries counts as delivered. `alias` names webhook_events.
 */
export function eligibleSql(c: Cutoffs, alias: string): SQL {
	const e = sql.raw(alias);
	return sql`(${e}.received_at < ${c.hotBefore}
		AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.event_id = ${e}.id AND d.status NOT IN ${TERMINAL})
		AND (${e}.received_at < ${c.failedBefore}
			OR NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.event_id = ${e}.id AND d.status IN ${FAILED})))`;
}

export async function countEligible(db: Db, c: Cutoffs): Promise<number> {
	const [r] = await db.all<{ n: number }>(
		sql`SELECT COUNT(*) AS n FROM webhook_events e WHERE ${eligibleSql(c, "e")}`,
	);
	return r?.n ?? 0;
}

/** UTC days with unmarked eligible events, oldest first. */
export async function eligibleDays(
	db: Db,
	c: Cutoffs,
): Promise<{ dayStart: number; count: number }[]> {
	return db.all<{ dayStart: number; count: number }>(sql`
		SELECT (e.received_at / ${DAY_MS}) * ${DAY_MS} AS dayStart, COUNT(*) AS count
		FROM webhook_events e
		WHERE e.archive_batch_id IS NULL AND ${eligibleSql(c, "e")}
		GROUP BY dayStart ORDER BY dayStart`);
}

/**
 * Marks up to `maxEvents` unmarked eligible events of one day, by ID, stopping
 * before the running payload size passes `maxRawBytes` — but always at least
 * one event, so an oversized event still gets a part (Review Focus 4).
 * One statement: concurrent instances can never mark the same event.
 */
export async function markPart(
	db: Db,
	a: {
		batchId: string;
		partNo: number;
		dayStart: number;
		cut: Cutoffs;
		maxEvents: number;
		maxRawBytes: number;
	},
): Promise<number> {
	const r = await db.run(sql`
		UPDATE webhook_events SET archive_batch_id = ${a.batchId}, archive_part = ${a.partNo}
		WHERE id IN (
			SELECT id FROM (
				SELECT e.id, e.size_bytes, SUM(e.size_bytes) OVER (ORDER BY e.id) AS running
				FROM webhook_events e
				WHERE e.archive_batch_id IS NULL
					AND e.received_at >= ${a.dayStart} AND e.received_at < ${a.dayStart + DAY_MS}
					AND ${eligibleSql(a.cut, "e")}
				ORDER BY e.id LIMIT ${a.maxEvents}
			) WHERE running <= ${a.maxRawBytes} OR running = size_bytes
		) AND archive_batch_id IS NULL`);
	return (r as unknown as { meta: { changes: number } }).meta.changes;
}

export async function countMarked(
	db: Db,
	batchId: string,
	partNo: number,
): Promise<number> {
	const [r] = await db.all<{ n: number }>(sql`
		SELECT COUNT(*) AS n FROM webhook_events WHERE archive_batch_id = ${batchId} AND archive_part = ${partNo}`);
	return r?.n ?? 0;
}

/** Replay (spec §7.4): the event is skipped by purge and archived again later. */
export function unmarkEventsStatements(
	db: Db,
	eventIds: string[],
): BatchItem[] {
	const unique = [...new Set(eventIds)];
	const out: BatchItem[] = [];
	for (let i = 0; i < unique.length; i += 90) {
		out.push(
			db
				.update(webhookEvents)
				.set({ archiveBatchId: null, archivePart: null })
				.where(
					and(
						inArray(webhookEvents.id, unique.slice(i, i + 90)),
						sql`archive_batch_id IS NOT NULL`,
					),
				),
		);
	}
	return out;
}
