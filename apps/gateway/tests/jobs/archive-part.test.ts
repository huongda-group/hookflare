import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cutoffsFor, DAY_MS } from "../../src/core/db/archive";
import { archiveParts, auditLogs } from "../../src/core/db/schema";
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
});
