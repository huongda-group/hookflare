import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cutoffsFor, DAY_MS } from "../../src/core/db/archive";
import {
	archiveBatches,
	archiveParts,
	auditLogs,
	deliveries,
	webhookEvents,
} from "../../src/core/db/schema";
import { gunzipToLines } from "../../src/jobs/archive/ndjson";
import { buildAuditPart, buildEventPart } from "../../src/jobs/archive/part";
import {
	deleteGonePayloads,
	deletePurgeChunk,
	finishBatch,
	purgeAuditPart,
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

describe("purge re-checks the batch inside the delete transaction (re-review)", () => {
	const unverify = (batchId: string) => () =>
		deps.db
			.update(archiveBatches)
			.set({ status: "failed" })
			.where(eq(archiveBatches.id, batchId));

	it("deletes no event when the batch leaves verified after requireVerified", async () => {
		const { batch, events } = await built();
		await verifyBatch(deps, batch.id);
		const sel = await selectPurgeChunk(deps, batch.id, 1, cut, "");
		beforeNextBatch(deps, unverify(batch.id));
		const deleted = await deletePurgeChunk(
			deps,
			batch.id,
			1,
			cut,
			sel.rows.map((r) => r.id),
		);
		expect(deleted).toBe(0);
		for (const e of events) expect(await eventExists(e.eventId)).toBe(true);
		expect(
			await deps.db
				.select()
				.from(deliveries)
				.where(eq(deliveries.id, events[0].deliveryId)),
		).toHaveLength(1);
	});

	it("deletes no audit row when the batch leaves verified after requireVerified", async () => {
		await deps.db.insert(auditLogs).values({
			id: "aud_purge_race",
			actor: "purge@test",
			action: "settings.updated",
			resourceType: "settings",
			resourceId: "x",
			at: DAY_START + 1,
		});
		try {
			const batch = await seedBatch(deps, { kind: "audit", day: "2026-01-02" });
			await buildAuditPart(deps, batch.id, 1);
			expect(await verifyBatch(deps, batch.id)).toEqual({ ok: true });
			beforeNextBatch(deps, unverify(batch.id));
			expect(await purgeAuditPart(deps, batch.id, 1)).toBe(0);
			expect(
				await deps.db
					.select()
					.from(auditLogs)
					.where(eq(auditLogs.id, "aud_purge_race")),
			).toHaveLength(1);
		} finally {
			await deps.db.delete(auditLogs).where(eq(auditLogs.id, "aud_purge_race"));
		}
	});
});

describe("missing R2 payload (re-review)", () => {
	it("leaves the event out of the part, unmarks it, and purge keeps it", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const p = await seedPipeline(deps);
			const lost = await seedDelivery(deps, p, {
				status: "delivered",
				body: big(),
				event: { receivedAt: DAY_START + 1 },
			});
			const kept = await seedDelivery(deps, p, {
				status: "delivered",
				body: big(),
				event: { receivedAt: DAY_START + 2 },
			});
			const [ev] = await deps.db
				.select()
				.from(webhookEvents)
				.where(eq(webhookEvents.id, lost.eventId));
			if (!ev.r2Key) throw new Error("test setup: event has no r2 key");
			await deps.payloads.delete(ev.r2Key);

			const batch = await seedBatch(deps, { day: "2026-01-02" });
			expect(await buildEventPart(deps, batch.id, 1, cut)).toMatchObject({
				itemCount: 1,
			});
			const [after] = await deps.db
				.select()
				.from(webhookEvents)
				.where(eq(webhookEvents.id, lost.eventId));
			expect(after).toMatchObject({ archiveBatchId: null, archivePart: null });
			const [part] = await deps.db
				.select()
				.from(archiveParts)
				.where(eq(archiveParts.batchId, batch.id));
			expect(part).toMatchObject({
				itemCount: 1,
				firstId: kept.eventId,
				lastId: kept.eventId,
			});
			const obj = await deps.payloads.get(part.r2Key as string);
			const lines = await gunzipToLines(
				new Uint8Array(await (obj as R2ObjectBody).arrayBuffer()),
			);
			expect(lines.map((l) => JSON.parse(l).event.id)).toEqual([kept.eventId]);
			expect(
				errorSpy.mock.calls.some(
					(c) =>
						String(c[0]).includes("archive.payload_missing") &&
						String(c[0]).includes(lost.eventId),
				),
			).toBe(true);

			expect(await verifyBatch(deps, batch.id)).toEqual({ ok: true });
			expect(await status(batch.id)).toMatchObject({ itemCount: 1 });
			expect((await purgeD1(batch.id)).deleted).toBe(1);
			expect(await eventExists(lost.eventId)).toBe(true);
			expect(await eventExists(kept.eventId)).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});
});
