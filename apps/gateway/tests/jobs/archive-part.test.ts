import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cutoffsFor, DAY_MS, MISSING_PART } from "../../src/core/db/archive";
import * as schema from "../../src/core/db/schema";
import {
	archiveParts,
	auditLogs,
	deliveries,
	deliveryAttempts,
	webhookEvents,
} from "../../src/core/db/schema";
import { gunzipToLines } from "../../src/jobs/archive/ndjson";
import { buildAuditPart, buildEventPart } from "../../src/jobs/archive/part";
import { isolateArchive, seedBatch } from "../helpers/archive";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const deps = testDeps();
const DAY = "2026-01-02";
const DAY_START = Date.UTC(2026, 0, 2);
const NOW = DAY_START + 400 * DAY_MS;
const cut = cutoffsFor(
	{ hot_retention_days: 30, failed_retention_days: 90 },
	NOW,
);

beforeEach(() => isolateArchive(deps));

function fromB64(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function readPart(batchId: string, partNo: number) {
	const [row] = await deps.db
		.select()
		.from(archiveParts)
		.where(
			and(eq(archiveParts.batchId, batchId), eq(archiveParts.partNo, partNo)),
		);
	const obj = await deps.payloads.get(row.r2Key as string);
	const lines = await gunzipToLines(
		new Uint8Array(await (obj as R2ObjectBody).arrayBuffer()),
	);
	return { row, lines: lines.map((l) => JSON.parse(l)) };
}

async function partRows(batchId: string) {
	return deps.db
		.select()
		.from(archiveParts)
		.where(eq(archiveParts.batchId, batchId));
}

async function markOf(eventId: string) {
	const [ev] = await deps.db
		.select()
		.from(webhookEvents)
		.where(eq(webhookEvents.id, eventId));
	return { batch: ev.archiveBatchId, part: ev.archivePart };
}

function d1Before(match: RegExp, before: () => Promise<unknown>): D1Database {
	const db = deps.env.DB;
	let fired = false;
	const wrap = (stmt: D1PreparedStatement, q: string): D1PreparedStatement =>
		new Proxy(stmt, {
			get(target, prop) {
				if (prop === "bind")
					return (...a: unknown[]) => wrap(target.bind(...a), q);
				const v = Reflect.get(target, prop);
				if (typeof v !== "function") return v;
				if (["all", "raw", "first", "run"].includes(String(prop)))
					return async (...a: unknown[]) => {
						if (!fired && match.test(q)) {
							fired = true;
							await before();
						}
						return v.apply(target, a);
					};
				return v.bind(target);
			},
		});
	return new Proxy(db, {
		get(target, prop) {
			if (prop === "prepare") return (q: string) => wrap(target.prepare(q), q);
			const v = Reflect.get(target, prop);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
}

describe("buildEventPart", () => {
	it("writes one line per event with inline and R2 payloads byte for byte", async () => {
		const p = await seedPipeline(deps);
		const inline = new TextEncoder().encode('{"a":1}');
		const big = new Uint8Array(70 * 1024).fill(7);
		const a = await seedDelivery(deps, p, {
			status: "delivered",
			body: inline,
			event: { receivedAt: DAY_START + 1 },
		});
		const b = await seedDelivery(deps, p, {
			status: "delivered",
			body: big,
			event: { receivedAt: DAY_START + 2 },
		});
		const batch = await seedBatch(deps, { day: DAY });
		expect(await buildEventPart(deps, batch.id, 1, cut)).toMatchObject({
			itemCount: 2,
		});
		const { row, lines } = await readPart(batch.id, 1);
		expect(row.r2Key).toBe(
			`archive/2026/01/02/${batch.id}/part-0001.ndjson.gz`,
		);
		expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(lines.map((l) => l.event.id).sort()).toEqual(
			[a.eventId, b.eventId].sort(),
		);
		const byId = Object.fromEntries(lines.map((l) => [l.event.id, l]));
		expect([...fromB64(byId[a.eventId].payload_b64)]).toEqual([...inline]);
		expect([...fromB64(byId[b.eventId].payload_b64)]).toEqual([...big]);
		expect(byId[a.eventId].v).toBe(1);
		expect(byId[a.eventId].event).not.toHaveProperty("body_inline");
		expect(byId[a.eventId].event).not.toHaveProperty("archive_batch_id");
		expect(byId[a.eventId].deliveries[0].attempts).toEqual(expect.any(Array));
	});

	it("is idempotent: a rerun reuses the marks and overwrites the same key", async () => {
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: DAY_START + 1 },
		});
		const batch = await seedBatch(deps, { day: DAY });
		const first = await buildEventPart(deps, batch.id, 1, cut);
		const again = await buildEventPart(deps, batch.id, 1, cut);
		expect(again).toEqual(first);
		expect(await buildEventPart(deps, batch.id, 2, cut)).toEqual({
			itemCount: 0,
			bytes: 0,
		});
	});

	it("puts one oversized event alone in a part (Review Focus 4)", async () => {
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: DAY_START + 1, sizeBytes: 40 * 1024 * 1024 },
		});
		await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: DAY_START + 2, sizeBytes: 10 },
		});
		const batch = await seedBatch(deps, { day: DAY });
		expect((await buildEventPart(deps, batch.id, 1, cut)).itemCount).toBe(1);
		expect((await buildEventPart(deps, batch.id, 2, cut)).itemCount).toBe(1);
		expect((await buildEventPart(deps, batch.id, 3, cut)).itemCount).toBe(0);
	});

	it("writes no file when the batch has no files (M5-21)", async () => {
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: DAY_START + 1 },
		});
		const batch = await seedBatch(deps, { day: DAY, withFiles: false });
		expect((await buildEventPart(deps, batch.id, 1, cut)).itemCount).toBe(1);
		const [row] = await deps.db
			.select()
			.from(archiveParts)
			.where(eq(archiveParts.batchId, batch.id));
		expect(row.r2Key).toBeNull();
	});

	it("throws for an unknown batch", async () => {
		await expect(buildEventPart(deps, "arb_nope", 1, cut)).rejects.toThrow(
			"archive batch arb_nope not found",
		);
		await expect(buildAuditPart(deps, "arb_nope", 1)).rejects.toThrow(
			"archive batch arb_nope not found",
		);
	});

	it("leaves a batch that is no longer building untouched", async () => {
		const p = await seedPipeline(deps);
		const { eventId } = await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: DAY_START + 1 },
		});
		const batch = await seedBatch(deps, { day: DAY, status: "verified" });
		expect(await buildEventPart(deps, batch.id, 1, cut)).toEqual({
			itemCount: 0,
			bytes: 0,
		});
		expect(await markOf(eventId)).toEqual({ batch: null, part: null });
		expect(await partRows(batch.id)).toEqual([]);
	});

	it("records no part and parks the events when every marked event's R2 payload is gone", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const p = await seedPipeline(deps);
			const { eventId } = await seedDelivery(deps, p, {
				status: "delivered",
				body: new Uint8Array(70 * 1024),
				event: { receivedAt: DAY_START + 1 },
			});
			const [ev] = await deps.db
				.select()
				.from(webhookEvents)
				.where(eq(webhookEvents.id, eventId));
			await deps.payloads.delete(ev.r2Key as string);
			const batch = await seedBatch(deps, { day: DAY });
			expect(await buildEventPart(deps, batch.id, 1, cut)).toEqual({
				itemCount: 0,
				bytes: 0,
				parked: 1,
			});
			expect(await partRows(batch.id)).toEqual([]);
			expect(await markOf(eventId)).toEqual({
				batch: batch.id,
				part: MISSING_PART,
			});
			expect(await buildEventPart(deps, batch.id, 2, cut)).toEqual({
				itemCount: 0,
				bytes: 0,
			});
			expect(
				errorSpy.mock.calls.map((c) => JSON.parse(String(c[0])).msg),
			).toContain("archive.payload_missing");
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("nests every delivery with its attempts in order, and lists an event without deliveries", async () => {
		const p = await seedPipeline(deps);
		const first = await seedDelivery(deps, p, {
			status: "dead",
			event: { receivedAt: DAY_START + 1 },
		});
		const second = await seedDelivery(deps, p, {
			status: "delivered",
			eventId: first.eventId,
		});
		for (const n of [1, 2])
			await deps.db.insert(deliveryAttempts).values({
				id: `att_part_${n}`,
				deliveryId: first.deliveryId,
				attemptNo: n,
				startedAt: DAY_START + n,
				durationMs: 5,
				httpStatus: 500,
			});
		const lonely = await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: DAY_START + 2 },
		});
		await deps.db
			.delete(deliveries)
			.where(eq(deliveries.id, lonely.deliveryId));

		const batch = await seedBatch(deps, { day: DAY });
		expect((await buildEventPart(deps, batch.id, 1, cut)).itemCount).toBe(2);
		const { lines } = await readPart(batch.id, 1);
		const byId = Object.fromEntries(lines.map((l) => [l.event.id, l]));
		const ds = byId[first.eventId].deliveries;
		expect(ds.map((d: { id: string }) => d.id).sort()).toEqual(
			[first.deliveryId, second.deliveryId].sort(),
		);
		const failed = ds.find((d: { id: string }) => d.id === first.deliveryId);
		expect(
			failed.attempts.map((a: { attempt_no: number }) => a.attempt_no),
		).toEqual([1, 2]);
		const ok = ds.find((d: { id: string }) => d.id === second.deliveryId);
		expect(ok.attempts).toEqual([]);
		expect(byId[lonely.eventId].deliveries).toEqual([]);
	});

	it("writes a null payload for an event a replay unmarks while its page is read", async () => {
		const p = await seedPipeline(deps);
		const { eventId } = await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: DAY_START + 1 },
		});
		const batch = await seedBatch(deps, { day: DAY });
		const racing = {
			...deps,
			db: drizzle(
				d1Before(/"body_inline" from "webhook_events"/, () =>
					deps.db.run(
						sql`UPDATE webhook_events SET archive_batch_id = NULL, archive_part = NULL WHERE id = ${eventId}`,
					),
				),
				{ schema },
			),
		};
		expect((await buildEventPart(racing, batch.id, 1, cut)).itemCount).toBe(1);
		const { lines } = await readPart(batch.id, 1);
		expect(lines).toHaveLength(1);
		expect(lines[0].event.id).toBe(eventId);
		expect(lines[0].payload_b64).toBeNull();
		expect(await markOf(eventId)).toEqual({ batch: null, part: null });
	});
});

describe("buildAuditPart", () => {
	it("archives the day's audit rows in ID order across parts", async () => {
		await deps.db.delete(auditLogs).where(eq(auditLogs.actor, "archive@test"));
		for (let i = 0; i < 3; i++) {
			await deps.db.insert(auditLogs).values({
				id: `aud_arch_${i}`,
				actor: "archive@test",
				action: "settings.updated",
				resourceType: "settings",
				resourceId: "x",
				at: DAY_START + i,
			});
		}
		const batch = await seedBatch(deps, { kind: "audit", day: DAY });
		expect(
			(await buildAuditPart(deps, batch.id, 1)).itemCount,
		).toBeGreaterThanOrEqual(3);
		const { lines } = await readPart(batch.id, 1);
		expect(lines.filter((l) => l.audit.actor === "archive@test")).toHaveLength(
			3,
		);
	});

	const AUDIT_ACTOR = "archive-parts@test";
	const clearAudit = () =>
		deps.db.delete(auditLogs).where(eq(auditLogs.actor, AUDIT_ACTOR));
	const AUDIT_DAY = "2025-03-04";
	const AUDIT_DAY_START = Date.UTC(2025, 2, 4);
	async function seedDayAudit(ids: string[]) {
		for (const [i, id] of ids.entries())
			await deps.db.insert(auditLogs).values({
				id,
				actor: AUDIT_ACTOR,
				action: "settings.updated",
				resourceType: "settings",
				resourceId: "x",
				at: AUDIT_DAY_START + i,
			});
	}

	it("returns nothing for a batch that is no longer building, or a day without rows", async () => {
		await clearAudit();
		const verified = await seedBatch(deps, {
			kind: "audit",
			day: AUDIT_DAY,
			status: "verified",
		});
		await seedDayAudit(["aud_day_a"]);
		try {
			expect(await buildAuditPart(deps, verified.id, 1)).toEqual({
				itemCount: 0,
				bytes: 0,
			});
			const empty = await seedBatch(deps, { kind: "audit", day: "2025-03-05" });
			expect(await buildAuditPart(deps, empty.id, 1)).toEqual({
				itemCount: 0,
				bytes: 0,
			});
			expect(await partRows(verified.id)).toEqual([]);
			expect(await partRows(empty.id)).toEqual([]);
		} finally {
			await clearAudit();
		}
	});

	it("a later part starts after the previous one, and a rebuilt part keeps its range", async () => {
		await clearAudit();
		await seedDayAudit(["aud_day_1", "aud_day_2"]);
		try {
			const batch = await seedBatch(deps, {
				kind: "audit",
				day: AUDIT_DAY,
				withFiles: false,
			});
			await deps.db.insert(archiveParts).values({
				batchId: batch.id,
				partNo: 1,
				r2Key: null,
				itemCount: 1,
				bytes: 0,
				sha256: null,
				firstId: "aud_day_1",
				lastId: "aud_day_1",
			});
			expect(await buildAuditPart(deps, batch.id, 1)).toEqual({
				itemCount: 1,
				bytes: 0,
			});
			expect(await buildAuditPart(deps, batch.id, 2)).toEqual({
				itemCount: 1,
				bytes: 0,
			});
			const parts = await partRows(batch.id);
			expect(
				parts
					.sort((a, b) => a.partNo - b.partNo)
					.map((r) => [r.partNo, r.firstId, r.lastId, r.r2Key]),
			).toEqual([
				[1, "aud_day_1", "aud_day_1", null],
				[2, "aud_day_2", "aud_day_2", null],
			]);
			expect(await buildAuditPart(deps, batch.id, 3)).toEqual({
				itemCount: 0,
				bytes: 0,
			});
		} finally {
			await clearAudit();
		}
	});
});
