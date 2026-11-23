import { and, eq, inArray, ne, type SQL, sql } from "drizzle-orm";
import {
	type Cutoffs,
	DAY_MS,
	eligibleSql,
	MISSING_PART,
} from "../../core/db/archive";
import {
	archiveBatches,
	archiveParts,
	auditLogs,
	deliveries,
	deliveryAttempts,
	webhookEvents,
} from "../../core/db/schema";
import type { Deps } from "../../deps";
import { dayStartOf } from "./keys";

export const PURGE_CHUNK = 500;
const ID_SLICE = 90;

export type PurgeRow = { id: string; r2Key: string | null };
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

const verifiedSql = (batchId: string): SQL =>
	sql`EXISTS (SELECT 1 FROM archive_batches WHERE id = ${batchId} AND status = 'verified')`;

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
		)}) AND ${markSql(batchId, partNo)} AND ${eligibleSql(cut, "e")} AND ${verifiedSql(batchId)}`;
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
	const [deleted] = await deps.db.batch([
		deps.db
			.delete(auditLogs)
			.where(
				sql`at >= ${from} AND at < ${from + DAY_MS} AND id >= ${part.firstId} AND id <= ${part.lastId} AND ${verifiedSql(batchId)}`,
			)
			.returning({ id: auditLogs.id }),
	]);
	return deleted.length;
}

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
					ne(webhookEvents.archivePart, MISSING_PART),
					sql`EXISTS (SELECT 1 FROM archive_batches WHERE id = ${batchId} AND status = 'purged')`,
				),
			),
	]);
}
