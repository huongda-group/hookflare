import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cutoffsFor, DAY_MS } from "../../src/core/db/archive";
import {
	archiveBatches,
	archiveParts,
	deliveries,
	webhookEvents,
} from "../../src/core/db/schema";
import { buildEventPart } from "../../src/jobs/archive/part";
import {
	deleteGonePayloads,
	deletePurgeChunk,
	finishBatch,
	selectPurgeChunk,
} from "../../src/jobs/archive/purge";
import { verifyBatch } from "../../src/jobs/archive/verify";
import { beforeNextBatch } from "../helpers/admin";
import { isolateArchive, listKeys, seedBatch } from "../helpers/archive";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const deps = testDeps();
const DAY_START = Date.UTC(2026, 0, 2);
const cut = cutoffsFor(
	{ hot_retention_days: 30, failed_retention_days: 90 },
	DAY_START + 400 * DAY_MS,
);
const big = () => new Uint8Array(70 * 1024).fill(1);

beforeEach(() => isolateArchive(deps));

async function built(n = 2) {
	const p = await seedPipeline(deps);
	const events = [];
	for (let i = 0; i < n; i++)
		events.push(
			await seedDelivery(deps, p, {
				status: "delivered",
				body: big(),
				event: { receivedAt: DAY_START + i },
			}),
		);
	const batch = await seedBatch(deps, { day: "2026-01-02" });
	await buildEventPart(deps, batch.id, 1, cut);
	return { batch, events };
}
const status = async (id: string) =>
	(
		await deps.db.select().from(archiveBatches).where(eq(archiveBatches.id, id))
	)[0];
/** Select + D1 delete of part 1's first chunk; R2 is left to the caller. */
async function purgeD1(batchId: string) {
	const sel = await selectPurgeChunk(deps, batchId, 1, cut, "");
	const deleted = await deletePurgeChunk(
		deps,
		batchId,
		1,
		cut,
		sel.rows.map((r) => r.id),
	);
	return { ...sel, deleted };
}
const eventExists = async (id: string) =>
	(await deps.db.select().from(webhookEvents).where(eq(webhookEvents.id, id)))
		.length === 1;

describe("verifyBatch", () => {
	it("verifies sizes, hashes, and counts and writes the manifest", async () => {
		const { batch } = await built();
		expect(await verifyBatch(deps, batch.id)).toEqual({ ok: true });
		const b = await status(batch.id);
		expect(b).toMatchObject({ status: "verified", partCount: 1, itemCount: 2 });
		const manifest = await deps.payloads.get(
			`archive/2026/01/02/${batch.id}/manifest.json`,
		);
		expect(JSON.parse(await (manifest as R2ObjectBody).text())).toMatchObject({
			batch_id: batch.id,
			parts: [{ part_no: 1, item_count: 2 }],
		});
		expect(await verifyBatch(deps, batch.id)).toEqual({ ok: true }); // idempotent
	});

	it.each(["size", "hash", "count"])(
		"fails on a %s mismatch and purges nothing",
		async (what) => {
			const { batch, events } = await built();
			if (what === "size")
				await deps.db
					.update(archiveParts)
					.set({ bytes: 1 })
					.where(eq(archiveParts.batchId, batch.id));
			if (what === "hash")
				await deps.db
					.update(archiveParts)
					.set({ sha256: "0".repeat(64) })
					.where(eq(archiveParts.batchId, batch.id));
			if (what === "count")
				await deps.db
					.update(archiveParts)
					.set({ itemCount: 1 })
					.where(eq(archiveParts.batchId, batch.id));
			const r = await verifyBatch(deps, batch.id);
			expect(r.ok).toBe(false);
			expect((await status(batch.id)).status).toBe("failed");
			await expect(
				selectPurgeChunk(deps, batch.id, 1, cut, ""),
			).rejects.toThrow(/not verified/);
			await expect(
				deletePurgeChunk(deps, batch.id, 1, cut, [events[0].eventId]),
			).rejects.toThrow(/not verified/);
			// The failed batch releases its events (I6).
			const [ev] = await deps.db
				.select()
				.from(webhookEvents)
				.where(eq(webhookEvents.id, events[0].eventId));
			expect(ev.archiveBatchId).toBeNull();
			expect(await eventExists(events[0].eventId)).toBe(true);
		},
	);
});

describe("purge", () => {
	it("lists the chunk, deletes D1 rows, then deletes only the gone events' objects", async () => {
		const { batch, events } = await built();
		await verifyBatch(deps, batch.id);
		const chunk = await purgeD1(batch.id);
		expect(chunk).toMatchObject({ deleted: 2, done: true });
		const keys = chunk.rows.map((r) => r.r2Key as string);
		expect(keys.every(Boolean)).toBe(true);
		expect(await eventExists(events[0].eventId)).toBe(false);
		expect(
			await deps.db
				.select()
				.from(deliveries)
				.where(eq(deliveries.id, events[0].deliveryId)),
		).toEqual([]);
		// R2 still there until the third step (M5-20).
		expect(await deps.payloads.head(keys[0])).not.toBeNull();
		expect(await deleteGonePayloads(deps, chunk.rows)).toBe(2);
		expect(await deps.payloads.head(keys[0])).toBeNull();
		// Retried steps match nothing and are no-ops.
		expect(
			await deletePurgeChunk(
				deps,
				batch.id,
				1,
				cut,
				chunk.rows.map((r) => r.id),
			),
		).toBe(0);
		expect(await selectPurgeChunk(deps, batch.id, 1, cut, "")).toEqual({
			rows: [],
			done: true,
		});
		await deleteGonePayloads(deps, chunk.rows);
		await finishBatch(deps, batch.id);
		expect((await status(batch.id)).status).toBe("purged");
		expect(
			await listKeys(deps.payloads, `archive/2026/01/02/${batch.id}/`),
		).toHaveLength(2); // part + manifest stay
	});

	it("skips an event that got a replay after its part was built", async () => {
		const { batch, events } = await built();
		await verifyBatch(deps, batch.id);
		// A replay inserts a non-terminal delivery and clears the mark.
		await deps.db
			.update(webhookEvents)
			.set({ archiveBatchId: null, archivePart: null })
			.where(eq(webhookEvents.id, events[0].eventId));
		expect((await purgeD1(batch.id)).deleted).toBe(1);
		expect(await eventExists(events[0].eventId)).toBe(true);
	});

	it("archive_enabled = false: verifies and purges without any R2 file (M5-21)", async () => {
		const p = await seedPipeline(deps);
		const { eventId } = await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: DAY_START },
		});
		const batch = await seedBatch(deps, {
			day: "2026-01-02",
			withFiles: false,
		});
		await buildEventPart(deps, batch.id, 1, cut);
		expect(await verifyBatch(deps, batch.id)).toEqual({ ok: true });
		expect((await purgeD1(batch.id)).deleted).toBe(1);
		await finishBatch(deps, batch.id);
		expect(await eventExists(eventId)).toBe(false);
		expect(
			await listKeys(deps.payloads, `archive/2026/01/02/${batch.id}/`),
		).toEqual([]);
	});

	it("skips an event that became ineligible after build (non-terminal delivery)", async () => {
		const { batch, events } = await built();
		await verifyBatch(deps, batch.id);
		await deps.db.run(
			sql`UPDATE deliveries SET status = 'retrying' WHERE id = ${events[1].deliveryId}`,
		);
		expect((await purgeD1(batch.id)).deleted).toBe(1);
		expect(await eventExists(events[1].eventId)).toBe(true);
	});

	it("deletes R2 objects only for events the D1 delete actually removed (SELECT-vs-delete race)", async () => {
		const { batch, events } = await built();
		await verifyBatch(deps, batch.id);
		const sel = await selectPurgeChunk(deps, batch.id, 1, cut, "");
		const victim = sel.rows.find((r) => r.id === events[0].eventId);
		const other = sel.rows.find((r) => r.id === events[1].eventId);
		if (!victim?.r2Key || !other?.r2Key)
			throw new Error("test setup: events have no r2 key");
		const victimKey = victim.r2Key;
		// A replay lands between the SELECT step and the D1 delete and clears
		// the victim's mark, so the delete skips it.
		beforeNextBatch(deps, () =>
			deps.db
				.update(webhookEvents)
				.set({ archiveBatchId: null, archivePart: null })
				.where(eq(webhookEvents.id, victim.id)),
		);
		const deleted = await deletePurgeChunk(
			deps,
			batch.id,
			1,
			cut,
			sel.rows.map((r) => r.id),
		);
		expect(deleted).toBe(1);
		expect(await eventExists(victim.id)).toBe(true);
		expect(await deleteGonePayloads(deps, sel.rows)).toBe(1);
		// The skipped event's payload object survives; the other one is gone.
		expect(await deps.payloads.head(victimKey)).not.toBeNull();
		expect(await deps.payloads.head(other.r2Key)).toBeNull();
	});
});
