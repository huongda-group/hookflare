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
	deletePayloadObjects,
	finishBatch,
	purgeEventChunk,
} from "../../src/jobs/archive/purge";
import { verifyBatch } from "../../src/jobs/archive/verify";
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
			await expect(purgeEventChunk(deps, batch.id, 1, cut)).rejects.toThrow(
				/not verified/,
			);
			expect(await eventExists(events[0].eventId)).toBe(true);
		},
	);
});

describe("purge", () => {
	it("deletes D1 rows first, returns the R2 keys, then deletes the objects", async () => {
		const { batch, events } = await built();
		await verifyBatch(deps, batch.id);
		const chunk = await purgeEventChunk(deps, batch.id, 1, cut);
		expect(chunk).toMatchObject({ deleted: 2, done: true });
		expect(chunk.r2Keys).toHaveLength(2);
		expect(await eventExists(events[0].eventId)).toBe(false);
		expect(
			await deps.db
				.select()
				.from(deliveries)
				.where(eq(deliveries.id, events[0].deliveryId)),
		).toEqual([]);
		// R2 still there until the second step: a crash here leaves only orphans (M5-20).
		expect(await deps.payloads.head(chunk.r2Keys[0])).not.toBeNull();
		await deletePayloadObjects(deps, chunk.r2Keys);
		expect(await deps.payloads.head(chunk.r2Keys[0])).toBeNull();
		// Retried D1 step matches nothing; retried R2 step is a no-op.
		expect(await purgeEventChunk(deps, batch.id, 1, cut)).toEqual({
			deleted: 0,
			r2Keys: [],
			done: true,
		});
		await deletePayloadObjects(deps, chunk.r2Keys);
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
		const chunk = await purgeEventChunk(deps, batch.id, 1, cut);
		expect(chunk.deleted).toBe(1);
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
		expect((await purgeEventChunk(deps, batch.id, 1, cut)).deleted).toBe(1);
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
		expect((await purgeEventChunk(deps, batch.id, 1, cut)).deleted).toBe(1);
		expect(await eventExists(events[1].eventId)).toBe(true);
	});
});
