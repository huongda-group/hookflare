import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
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
/** IN-list slice: with the mark and the cut-offs it stays under D1's 100-param cap. */
const ID_SLICE = 90;

export type PurgeRow = { id: string; r2Key: string | null };
/** At most PURGE_CHUNK rows (~60 KB), well under the 1 MiB step output limit. */
export type PurgeSelection = { rows: PurgeRow[]; done: boolean };

async function requireVerified(deps: Deps, batchId: string) {
	const b = await deps.db
		.select()
		.from(archiveBatches)
		.where(eq(archiveBatches.id, batchId))
		.get();
	if (b?.status !== "verified")
		throw new Error(`archive batch ${batchId} is not verified`);
	return b;
}

function slices<T>(items: T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += ID_SLICE)
		out.push(items.slice(i, i + ID_SLICE));
	return out;
}

const markSql = (batchId: string, partNo: number): SQL =>
	sql`e.archive_batch_id = ${batchId} AND e.archive_part = ${partNo}`;

/**
 * Spec §7.4 `purge`, step 1 of 3. Lists the next chunk of events of the part
 * that are still marked and eligible, with their R2 keys. The list is the
 * step's persisted result, so a crash after the D1 delete still knows which
 * payload objects to remove (M5-20). `after` is the last ID of the previous
 * chunk, so the loop always advances.
 */
export async function selectPurgeChunk(
	deps: Deps,
	batchId: string,
	partNo: number,
	cut: Cutoffs,
	after: string,
): Promise<PurgeSelection> {
	await requireVerified(deps, batchId);
	const rows = await deps.db.all<{ id: string; r2_key: string | null }>(sql`
		SELECT e.id, e.r2_key FROM webhook_events e
		WHERE ${markSql(batchId, partNo)} AND e.id > ${after} AND ${eligibleSql(cut, "e")}
		ORDER BY e.id LIMIT ${PURGE_CHUNK}`);
	return {
		rows: rows.map((r) => ({ id: r.id, r2Key: r.r2_key })),
		done: rows.length < PURGE_CHUNK,
	};
}

/**
 * Step 2 of 3, D1. Deletes only the selected IDs, and every statement repeats
 * the mark and eligibility, so an event that was unmarked (replay) or got a
 * live delivery after the part was built survives (M5-17). One db.batch is
 * one transaction; a retry matches no rows.
 */
export async function deletePurgeChunk(
	deps: Deps,
	batchId: string,
	partNo: number,
	cut: Cutoffs,
	ids: string[],
): Promise<number> {
	await requireVerified(deps, batchId);
	if (ids.length === 0) return 0;
	const statements = slices(ids).flatMap((slice) => {
		const target = sql`SELECT e.id FROM webhook_events e WHERE e.id IN (${sql.join(
			slice.map((id) => sql`${id}`),
			sql`, `,
		)}) AND ${markSql(batchId, partNo)} AND ${eligibleSql(cut, "e")}`;
		return [
			deps.db
				.delete(deliveryAttempts)
				.where(
					sql`delivery_id IN (SELECT d.id FROM deliveries d WHERE d.event_id IN (${target}))`,
				),
			deps.db.delete(deliveries).where(sql`event_id IN (${target})`),
			deps.db
				.delete(webhookEvents)
				.where(sql`id IN (${target})`)
				.returning({ id: webhookEvents.id }),
		] as const;
	});
	const [first, ...rest] = statements;
	const results = await deps.db.batch([first, ...rest]);
	let deleted = 0;
	for (let i = 2; i < results.length; i += 3)
		deleted += (results[i] as unknown[]).length;
	return deleted;
}

/**
 * Step 3 of 3, R2. Recomputes which of the selected events are gone from D1
 * and deletes only their payload objects: the key of an event the delete
 * skipped is never touched. Deleting a missing key is a no-op, so a retry
 * (or a retry of step 2 that deleted nothing new) is safe.
 */
export async function deleteGonePayloads(
	deps: Deps,
	rows: PurgeRow[],
): Promise<number> {
	const keyed = rows.filter((r) => r.r2Key);
	if (keyed.length === 0) return 0;
	const alive = new Set<string>();
	for (const slice of slices(keyed.map((r) => r.id))) {
		const kept = await deps.db
			.select({ id: webhookEvents.id })
			.from(webhookEvents)
			.where(inArray(webhookEvents.id, slice));
		for (const k of kept) alive.add(k.id);
	}
	const keys = keyed.flatMap((r) =>
		r.r2Key && !alive.has(r.id) ? [r.r2Key] : [],
	);
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

/** Every part the batch has a row for; verify covered exactly these. */
export async function listParts(
	deps: Deps,
	batchId: string,
): Promise<number[]> {
	const rows = await deps.db
		.select({ n: archiveParts.partNo })
		.from(archiveParts)
		.where(eq(archiveParts.batchId, batchId))
		.orderBy(archiveParts.partNo);
	return rows.map((r) => r.n);
}

/**
 * Sets `purged` and, in the same batch, clears the marks of every event the
 * purge left in D1 (it became ineligible, or was marked for a part that was
 * never built), so no event stays marked forever; a later batch archives it.
 */
export async function finishBatch(deps: Deps, batchId: string): Promise<void> {
	await deps.db.batch([
		deps.db
			.update(archiveBatches)
			.set({ status: "purged", purgedAt: deps.now() })
			.where(
				and(
					eq(archiveBatches.id, batchId),
					eq(archiveBatches.status, "verified"),
				),
			),
		deps.db
			.update(webhookEvents)
			.set({ archiveBatchId: null, archivePart: null })
			.where(
				and(
					eq(webhookEvents.archiveBatchId, batchId),
					sql`EXISTS (SELECT 1 FROM archive_batches WHERE id = ${batchId} AND status = 'purged')`,
				),
			),
	]);
}
