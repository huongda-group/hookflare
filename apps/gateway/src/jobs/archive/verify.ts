import { and, eq, sql } from "drizzle-orm";
import { countMarked, DAY_MS } from "../../core/db/archive";
import { archiveBatches, archiveParts } from "../../core/db/schema";
import type { Deps } from "../../deps";
import { batchPrefix, dayStartOf, manifestKey } from "./keys";

export type VerifyResult = { ok: true } | { ok: false; error: string };

const hex = (buf: ArrayBuffer | undefined) =>
	buf
		? [...new Uint8Array(buf)]
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("")
		: null;

/** Spec §7.4 `verify`. Any mismatch sets `failed`; a failed batch is never purged. */
export async function verifyBatch(
	deps: Deps,
	batchId: string,
): Promise<VerifyResult> {
	const batch = await deps.db
		.select()
		.from(archiveBatches)
		.where(eq(archiveBatches.id, batchId))
		.get();
	if (!batch) throw new Error(`archive batch ${batchId} not found`);
	if (batch.status === "verified" || batch.status === "purged")
		return { ok: true };
	if (batch.status !== "building")
		return { ok: false, error: batch.error ?? `status ${batch.status}` };
	const parts = await deps.db
		.select()
		.from(archiveParts)
		.where(eq(archiveParts.batchId, batchId))
		.orderBy(archiveParts.partNo);
	const fail = async (error: string): Promise<VerifyResult> => {
		await deps.db
			.update(archiveBatches)
			.set({ status: "failed", error })
			.where(
				and(
					eq(archiveBatches.id, batchId),
					eq(archiveBatches.status, "building"),
				),
			);
		return { ok: false, error };
	};
	for (const part of parts) {
		if (batch.withFiles) {
			const head = part.r2Key ? await deps.payloads.head(part.r2Key) : null;
			if (!head) return fail(`part ${part.partNo}: object missing`);
			if (head.size !== part.bytes)
				return fail(`part ${part.partNo}: size ${head.size} ≠ ${part.bytes}`);
			if (hex(head.checksums.sha256) !== part.sha256)
				return fail(`part ${part.partNo}: sha256 mismatch`);
		}
		// Replay only removes marks, so the live count can only shrink (spec §7.4).
		const live =
			batch.kind === "events"
				? await countMarked(deps.db, batchId, part.partNo)
				: await countAudit(
						deps,
						dayStartOf(batch.day),
						part.firstId,
						part.lastId,
					);
		if (live > part.itemCount)
			return fail(
				`part ${part.partNo}: ${live} rows > ${part.itemCount} archived`,
			);
	}
	const totals = {
		partCount: parts.length,
		itemCount: parts.reduce((s, p) => s + p.itemCount, 0),
		bytes: parts.reduce((s, p) => s + p.bytes, 0),
	};
	if (batch.withFiles) {
		const prefix = batchPrefix(batch.kind, batch.day, batchId);
		await deps.payloads.put(
			manifestKey(prefix),
			JSON.stringify(
				{
					batch_id: batchId,
					kind: batch.kind,
					day: batch.day,
					...{
						part_count: totals.partCount,
						item_count: totals.itemCount,
						bytes: totals.bytes,
					},
					parts: parts.map((p) => ({
						part_no: p.partNo,
						key: p.r2Key,
						item_count: p.itemCount,
						bytes: p.bytes,
						sha256: p.sha256,
						first_id: p.firstId,
						last_id: p.lastId,
					})),
					note: "An event can appear in more than one batch (it was replayed after being archived). The copy in the newest batch is the complete one.",
				},
				null,
				2,
			),
			{ httpMetadata: { contentType: "application/json" } },
		);
	}
	await deps.db
		.update(archiveBatches)
		.set({ status: "verified", verifiedAt: deps.now(), ...totals })
		.where(
			and(
				eq(archiveBatches.id, batchId),
				eq(archiveBatches.status, "building"),
			),
		);
	return { ok: true };
}

async function countAudit(
	deps: Deps,
	dayStart: number,
	firstId: string,
	lastId: string,
): Promise<number> {
	const [r] = await deps.db.all<{ n: number }>(sql`
		SELECT COUNT(*) AS n FROM audit_logs WHERE at >= ${dayStart} AND at < ${dayStart + DAY_MS} AND id >= ${firstId} AND id <= ${lastId}`);
	return r?.n ?? 0;
}
