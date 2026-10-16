import { and, eq, sql } from "drizzle-orm";
import {
	type Cutoffs,
	countMarked,
	DAY_MS,
	markPart,
} from "../../core/db/archive";
import {
	archiveBatches,
	archiveParts,
	webhookEvents,
} from "../../core/db/schema";
import type { Deps } from "../../deps";
import { batchPrefix, dayStartOf, partKey } from "./keys";
import { base64, groupBy, gzipLines, sha256Hex, toBytes } from "./ndjson";

export const PART_MAX_EVENTS = 5_000;
export const PART_MAX_RAW_BYTES = 32 * 1024 * 1024;
const PAGE = 90;
/** Spec §7.5: the `event` object of a line holds every webhook_events column but these. */
export const EVENT_LINE_EXCLUDED = [
	"body_inline", // sent as payload_b64
	"archive_batch_id",
	"archive_part",
] as const;
export const EVENT_LINE_COLUMNS = [
	"id",
	"project_id",
	"source_id",
	"provider_event_id",
	"received_at",
	"headers_json",
	"content_type",
	"size_bytes",
	"payload_sha256",
	"r2_key",
] as const;
const EVENT_COLUMNS = sql.raw(
	EVENT_LINE_COLUMNS.map((c) => `e.${c}`).join(", "),
);

export type PartResult = { itemCount: number; bytes: number };
type Batch = typeof archiveBatches.$inferSelect;

async function loadBatch(deps: Deps, batchId: string): Promise<Batch> {
	const b = await deps.db
		.select()
		.from(archiveBatches)
		.where(eq(archiveBatches.id, batchId))
		.get();
	if (!b) throw new Error(`archive batch ${batchId} not found`);
	return b;
}

/**
 * Spec §7.4 `part`. Reuses an existing mark, otherwise marks the next slice;
 * the R2 key is deterministic and the put overwrites, so a retry is safe.
 */
export async function buildEventPart(
	deps: Deps,
	batchId: string,
	partNo: number,
	cut: Cutoffs,
): Promise<PartResult> {
	const batch = await loadBatch(deps, batchId);
	// A verified batch must not change under its manifest.
	if (batch.status !== "building") return { itemCount: 0, bytes: 0 };
	let n = await countMarked(deps.db, batchId, partNo);
	if (n === 0) {
		n = await markPart(deps.db, {
			batchId,
			partNo,
			dayStart: dayStartOf(batch.day),
			cut,
			maxEvents: PART_MAX_EVENTS,
			maxRawBytes: PART_MAX_RAW_BYTES,
		});
	}
	if (n === 0) return { itemCount: 0, bytes: 0 };

	const [range] = await deps.db.all<{
		first: string;
		last: string;
		n: number;
	}>(sql`
		SELECT MIN(id) AS first, MAX(id) AS last, COUNT(*) AS n FROM webhook_events
		WHERE archive_batch_id = ${batchId} AND archive_part = ${partNo}`);
	let key: string | null = null;
	let bytes = 0;
	let sha: string | null = null;
	if (batch.withFiles) {
		const gz = await gzipLines(eventLines(deps, batchId, partNo));
		key = partKey(batchPrefix("events", batch.day, batchId), partNo);
		sha = await sha256Hex(gz);
		await deps.payloads.put(key, gz, {
			sha256: sha,
			httpMetadata: { contentType: "application/gzip" },
			customMetadata: { item_count: String(range.n) },
		});
		bytes = gz.byteLength;
	}
	const row = {
		batchId,
		partNo,
		r2Key: key,
		itemCount: range.n,
		bytes,
		sha256: sha,
		firstId: range.first,
		lastId: range.last,
	};
	await deps.db
		.insert(archiveParts)
		.values(row)
		.onConflictDoUpdate({
			target: [archiveParts.batchId, archiveParts.partNo],
			set: row,
		});
	return { itemCount: range.n, bytes };
}

/** One line per marked event, built page by page so memory stays bounded. */
async function* eventLines(
	deps: Deps,
	batchId: string,
	partNo: number,
): AsyncGenerator<string> {
	let after = "";
	for (;;) {
		const events = await deps.db.all<
			Record<string, unknown> & { id: string; r2_key: string | null }
		>(sql`
			SELECT ${EVENT_COLUMNS} FROM webhook_events e
			WHERE e.archive_batch_id = ${batchId} AND e.archive_part = ${partNo} AND e.id > ${after}
			ORDER BY e.id LIMIT ${PAGE}`);
		if (events.length === 0) return;
		const lo = events[0].id;
		const hi = events[events.length - 1].id;
		const scope = sql`e.archive_batch_id = ${batchId} AND e.archive_part = ${partNo} AND e.id >= ${lo} AND e.id <= ${hi}`;
		const [bodies, deliveries, attempts] = await Promise.all([
			deps.db
				.select({ id: webhookEvents.id, body: webhookEvents.bodyInline })
				.from(webhookEvents)
				.where(
					and(
						eq(webhookEvents.archiveBatchId, batchId),
						eq(webhookEvents.archivePart, partNo),
						sql`id >= ${lo} AND id <= ${hi}`,
					),
				),
			deps.db.all<
				Record<string, unknown> & { id: string; event_id: string }
			>(sql`
				SELECT d.* FROM deliveries d JOIN webhook_events e ON e.id = d.event_id WHERE ${scope} ORDER BY d.id`),
			deps.db.all<Record<string, unknown> & { delivery_id: string }>(sql`
				SELECT a.* FROM delivery_attempts a JOIN deliveries d ON d.id = a.delivery_id
				JOIN webhook_events e ON e.id = d.event_id WHERE ${scope} ORDER BY a.delivery_id, a.attempt_no`),
		]);
		const bodyOf = new Map(bodies.map((b) => [b.id, toBytes(b.body)]));
		const attemptsOf = groupBy(attempts, (a) => a.delivery_id);
		const deliveriesOf = groupBy(deliveries, (d) => d.event_id);
		for (const ev of events) {
			let payload: Uint8Array | null = bodyOf.get(ev.id) ?? null;
			if (ev.r2_key) {
				const obj = await deps.payloads.get(ev.r2_key);
				payload = obj ? new Uint8Array(await obj.arrayBuffer()) : null;
			}
			yield JSON.stringify({
				v: 1,
				event: ev,
				payload_b64: payload ? base64(payload) : null,
				deliveries: (deliveriesOf.get(ev.id) ?? []).map((d) => ({
					...d,
					attempts: attemptsOf.get(d.id) ?? [],
				})),
			});
		}
		after = hi;
	}
}

/** Audit rows never change, so parts are ID ranges within the day (spec §7.4). */
export async function buildAuditPart(
	deps: Deps,
	batchId: string,
	partNo: number,
): Promise<PartResult> {
	const batch = await loadBatch(deps, batchId);
	if (batch.status !== "building") return { itemCount: 0, bytes: 0 };
	const from = dayStartOf(batch.day);
	const existing = await deps.db
		.select()
		.from(archiveParts)
		.where(
			and(eq(archiveParts.batchId, batchId), eq(archiveParts.partNo, partNo)),
		)
		.get();
	const prev =
		partNo === 1
			? null
			: await deps.db
					.select()
					.from(archiveParts)
					.where(
						and(
							eq(archiveParts.batchId, batchId),
							eq(archiveParts.partNo, partNo - 1),
						),
					)
					.get();
	const afterId = prev?.lastId ?? "";
	const rows = await deps.db.all<Record<string, unknown> & { id: string }>(sql`
		SELECT * FROM audit_logs WHERE at >= ${from} AND at < ${from + DAY_MS} AND id > ${afterId}
		${existing ? sql`AND id <= ${existing.lastId}` : sql``}
		ORDER BY id LIMIT ${PART_MAX_EVENTS}`);
	if (rows.length === 0) return { itemCount: 0, bytes: 0 };
	let key: string | null = null;
	let bytes = 0;
	let sha: string | null = null;
	if (batch.withFiles) {
		async function* lines() {
			for (const r of rows) yield JSON.stringify({ v: 1, audit: r });
		}
		const gz = await gzipLines(lines());
		key = partKey(batchPrefix("audit", batch.day, batchId), partNo);
		sha = await sha256Hex(gz);
		await deps.payloads.put(key, gz, {
			sha256: sha,
			httpMetadata: { contentType: "application/gzip" },
		});
		bytes = gz.byteLength;
	}
	const row = {
		batchId,
		partNo,
		r2Key: key,
		itemCount: rows.length,
		bytes,
		sha256: sha,
		firstId: rows[0].id,
		lastId: rows[rows.length - 1].id,
	};
	await deps.db
		.insert(archiveParts)
		.values(row)
		.onConflictDoUpdate({
			target: [archiveParts.batchId, archiveParts.partNo],
			set: row,
		});
	return { itemCount: rows.length, bytes };
}
