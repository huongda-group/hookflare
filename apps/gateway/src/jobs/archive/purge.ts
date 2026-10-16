import { and, eq, sql } from "drizzle-orm";
import { type Cutoffs, DAY_MS, eligibleSql } from "../../core/db/archive";
import {
	archiveBatches,
	archiveParts,
	deliveries,
	deliveryAttempts,
	webhookEvents,
} from "../../core/db/schema";
import type { Deps } from "../../deps";
import { dayStartOf } from "./keys";

export const PURGE_CHUNK = 500;
export type PurgeChunk = { deleted: number; r2Keys: string[]; done: boolean };

async function requireVerified(deps: Deps, batchId: string) {
	const b = await deps.db
		.select()
		.from(archiveBatches)
		.where(eq(archiveBatches.id, batchId))
		.get();
	if (!b || b.status !== "verified")
		throw new Error(`archive batch ${batchId} is not verified`);
	return b;
}

/**
 * Spec §7.4 `purge`, D1 half. Every statement repeats the mark, the ID range,
 * and eligibility, so an event that was unmarked or got a live delivery after
 * the part was built survives (M5-17). Returns the R2 keys for the next step.
 */
export async function purgeEventChunk(
	deps: Deps,
	batchId: string,
	partNo: number,
	cut: Cutoffs,
): Promise<PurgeChunk> {
	await requireVerified(deps, batchId);
	const mark = sql`e.archive_batch_id = ${batchId} AND e.archive_part = ${partNo}`;
	const rows = await deps.db.all<{ id: string; r2_key: string | null }>(sql`
		SELECT e.id, e.r2_key FROM webhook_events e WHERE ${mark} AND ${eligibleSql(cut, "e")} ORDER BY e.id LIMIT ${PURGE_CHUNK}`);
	if (rows.length === 0) return { deleted: 0, r2Keys: [], done: true };
	const lo = rows[0].id;
	const hi = rows[rows.length - 1].id;
	const target = sql`SELECT e.id FROM webhook_events e WHERE ${mark} AND e.id >= ${lo} AND e.id <= ${hi} AND ${eligibleSql(cut, "e")}`;
	await deps.db.batch([
		deps.db
			.delete(deliveryAttempts)
			.where(
				sql`delivery_id IN (SELECT d.id FROM deliveries d WHERE d.event_id IN (${target}))`,
			),
		deps.db.delete(deliveries).where(sql`event_id IN (${target})`),
		deps.db.delete(webhookEvents).where(sql`id IN (${target})`),
	]);
	return {
		deleted: rows.length,
		r2Keys: rows.flatMap((r) => (r.r2_key ? [r.r2_key] : [])),
		done: rows.length < PURGE_CHUNK,
	};
}

/** R2 half: deleting a missing key is a no-op, so a retry is safe. */
export async function deletePayloadObjects(
	deps: Deps,
	keys: string[],
): Promise<number> {
	for (let i = 0; i < keys.length; i += 1000)
		await deps.payloads.delete(keys.slice(i, i + 1000));
	return keys.length;
}

export async function purgeAuditPart(
	deps: Deps,
	batchId: string,
	partNo: number,
): Promise<number> {
	const batch = await requireVerified(deps, batchId);
	const part = await deps.db
		.select()
		.from(archiveParts)
		.where(
			and(eq(archiveParts.batchId, batchId), eq(archiveParts.partNo, partNo)),
		)
		.get();
	if (!part) return 0;
	const from = dayStartOf(batch.day);
	const r = await deps.db.run(sql`
		DELETE FROM audit_logs WHERE at >= ${from} AND at < ${from + DAY_MS} AND id >= ${part.firstId} AND id <= ${part.lastId}`);
	return (r as unknown as { meta: { changes: number } }).meta.changes;
}

export async function finishBatch(deps: Deps, batchId: string): Promise<void> {
	await deps.db
		.update(archiveBatches)
		.set({ status: "purged", purgedAt: deps.now() })
		.where(
			and(
				eq(archiveBatches.id, batchId),
				eq(archiveBatches.status, "verified"),
			),
		);
}
