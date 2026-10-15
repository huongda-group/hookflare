import type { BulkReplayResult, ReplayResult } from "@hookflare/shared";
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { clearAccessKeyCache } from "../../src/admin/auth/access";
import { deliveries, destinations } from "../../src/core/db/schema";
import { newId } from "../../src/core/ids";
import { adminApp, auditRows } from "../helpers/admin";
import { type RecordingQueue, recordingQueue, testDeps } from "../helpers/deps";
import { faultyDeps } from "../helpers/faults";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const reason = "backend fixed";

beforeEach(() => {
	// Each adminApp mints fresh keys under the same kid.
	clearAccessKeyCache();
});

async function eventDeliveries(
	deps: ReturnType<typeof testDeps>,
	eventId: string,
) {
	return deps.db
		.select()
		.from(deliveries)
		.where(eq(deliveries.eventId, eventId))
		.orderBy(asc(deliveries.id));
}

describe("POST /events/:id/replay", () => {
	it("creates a new replay delivery, enqueues it, and audits it", async () => {
		const deps = testDeps({ queue: recordingQueue() });
		const p = await seedPipeline(deps);
		const { eventId, deliveryId } = await seedDelivery(deps, p, {
			status: "delivered",
		});
		const api = await adminApp(deps, { role: "operator" });
		const res = await api.request("POST", `/events/${eventId}/replay`, {
			reason,
		});
		expect(res.status).toBe(201);
		const body = await res.json<ReplayResult>();
		expect(body).toMatchObject({ status: "pending", enqueued: true });
		expect((deps.queue as RecordingQueue).sent).toEqual([
			{ deliveryId: body.delivery_id },
		]);
		const rows = await eventDeliveries(deps, eventId);
		expect(rows.map((r) => [r.id, r.kind, r.status])).toEqual([
			[deliveryId, "initial", "delivered"],
			[body.delivery_id, "replay", "queued"],
		]);
		expect(rows[1]).toMatchObject({ createdBy: api.email, attemptCount: 0 });
		const audits = await auditRows(deps, eventId);
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({
			action: "delivery.replayed",
			resourceType: "event",
			reason,
			diffJson: {
				replayed: [
					{ source_delivery_id: deliveryId, new_delivery_id: body.delivery_id },
				],
				skipped: [],
			},
		});
	});

	it("rejects a whitespace-only reason", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { eventId } = await seedDelivery(deps, p, { status: "dead" });
		const api = await adminApp(deps, { role: "operator" });
		const res = await api.request("POST", `/events/${eventId}/replay`, {
			reason: "   ",
		});
		expect(res.status).toBe(400);
		expect(await eventDeliveries(deps, eventId)).toHaveLength(1);
		expect(await auditRows(deps, eventId)).toEqual([]);
	});

	it("stores a replay to a paused destination as paused without enqueueing", async () => {
		const deps = testDeps({ queue: recordingQueue() });
		const p = await seedPipeline(deps, { destination: { status: "paused" } });
		const { eventId } = await seedDelivery(deps, p, { status: "dead" });
		const api = await adminApp(deps, { role: "operator" });
		const body = await (
			await api.request("POST", `/events/${eventId}/replay`, { reason })
		).json<ReplayResult>();
		expect(body).toMatchObject({ status: "paused", enqueued: false });
		expect((deps.queue as RecordingQueue).sent).toEqual([]);
	});

	it("answers 404, 409 destination_disabled, and 409 replay_in_progress", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { eventId } = await seedDelivery(deps, p, { status: "dead" });
		const api = await adminApp(deps, { role: "operator" });
		expect(
			(await api.request("POST", "/events/evt_missing/replay", { reason }))
				.status,
		).toBe(404);
		expect(
			(await api.request("POST", `/events/${eventId}/replay`, { reason }))
				.status,
		).toBe(201);
		const again = await api.request("POST", `/events/${eventId}/replay`, {
			reason,
		});
		expect(again.status).toBe(409);
		expect(await again.json()).toEqual({ error: "replay_in_progress" });

		await deps.db
			.update(destinations)
			.set({ status: "disabled" })
			.where(eq(destinations.id, p.destination.id));
		const other = await seedDelivery(deps, p, { status: "dead" });
		const disabled = await api.request(
			"POST",
			`/events/${other.eventId}/replay`,
			{
				reason,
			},
		);
		expect(disabled.status).toBe(409);
		expect(await disabled.json()).toEqual({ error: "destination_disabled" });
	});

	it("answers 409 payload_missing and 503 on an R2 error, writing nothing", async () => {
		const base = testDeps();
		const p = await seedPipeline(base);
		const { eventId } = await seedDelivery(base, p, {
			status: "dead",
			body: new Uint8Array(),
			event: { r2Key: `payloads/${crypto.randomUUID()}` },
		});
		const op = await adminApp(base, { role: "operator" });
		const missing = await op.request("POST", `/events/${eventId}/replay`, {
			reason,
		});
		expect(missing.status).toBe(409);
		expect(await missing.json()).toEqual({ error: "payload_missing" });

		clearAccessKeyCache(); // second app minted fresh keys under the same kid
		const broken = await adminApp(
			faultyDeps(base, { r2: [{ match: /^head / }] }),
			{
				email: op.email,
			},
		);
		expect(
			(await broken.request("POST", `/events/${eventId}/replay`, { reason }))
				.status,
		).toBe(503);
		expect(await eventDeliveries(base, eventId)).toHaveLength(1);
		expect(await auditRows(base, eventId)).toEqual([]);
	});

	it("reports enqueued:false and keeps the row pending when the queue fails", async () => {
		const deps = testDeps({ queue: recordingQueue({ fail: true }) });
		const p = await seedPipeline(deps);
		const { eventId } = await seedDelivery(deps, p, { status: "dead" });
		const api = await adminApp(deps, { role: "operator" });
		const res = await api.request("POST", `/events/${eventId}/replay`, {
			reason,
		});
		expect(res.status).toBe(201);
		const body = await res.json<ReplayResult>();
		expect(body).toMatchObject({ status: "pending", enqueued: false });
		const rows = await eventDeliveries(deps, eventId);
		expect(rows[1].status).toBe("pending"); // the reconciler picks it up
	});

	it("forbids a viewer", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { eventId } = await seedDelivery(deps, p, { status: "dead" });
		const api = await adminApp(deps, { role: "viewer" });
		expect(
			(await api.request("POST", `/events/${eventId}/replay`, { reason }))
				.status,
		).toBe(403);
	});
});

describe("POST /failures/replay", () => {
	it("replays failures, skips the rest with reasons, and writes one audit row", async () => {
		const deps = testDeps({ queue: recordingQueue() });
		const p = await seedPipeline(deps);
		const dead = await seedDelivery(deps, p, { status: "dead" });
		const final = await seedDelivery(deps, p, { status: "failed_final" });
		const ok = await seedDelivery(deps, p, { status: "delivered" });
		const missing = newId("dlv");
		const api = await adminApp(deps, { role: "operator" });
		const res = await api.request("POST", "/failures/replay", {
			delivery_ids: [dead.deliveryId, final.deliveryId, ok.deliveryId, missing],
			reason,
		});
		expect(res.status).toBe(200);
		const body = await res.json<BulkReplayResult>();
		expect(body.replayed.map((r) => [r.delivery_id, r.enqueued])).toEqual([
			[dead.deliveryId, true],
			[final.deliveryId, true],
		]);
		expect(body.skipped).toEqual([
			{ delivery_id: ok.deliveryId, reason: "not_failed" },
			{ delivery_id: missing, reason: "not_found" },
		]);
		expect((deps.queue as RecordingQueue).sent).toHaveLength(2);
		const audits = (await deps.db.query.auditLogs.findMany()).filter(
			(a) => a.action === "delivery.replayed" && a.actorEmail === api.email,
		);
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({
			resourceType: "delivery",
			resourceId: null,
		});
		expect(audits[0].diffJson).toMatchObject({
			skipped: body.skipped,
			replayed: body.replayed.map((r) => ({
				source_delivery_id: r.delivery_id,
				new_delivery_id: r.new_delivery_id,
			})),
		});
	});

	it("deduplicates repeated delivery ids", async () => {
		const deps = testDeps({ queue: recordingQueue() });
		const p = await seedPipeline(deps);
		const dead = await seedDelivery(deps, p, { status: "dead" });
		const api = await adminApp(deps, { role: "operator" });
		const body = await (
			await api.request("POST", "/failures/replay", {
				delivery_ids: [dead.deliveryId, dead.deliveryId],
				reason,
			})
		).json<BulkReplayResult>();
		expect(body.replayed).toHaveLength(1);
		expect(body.skipped).toEqual([]);
		expect(await eventDeliveries(deps, dead.eventId)).toHaveLength(2);
	});

	it("skips a second failure of the same event and destination as replay_in_progress", async () => {
		const deps = testDeps({ queue: recordingQueue() });
		const p = await seedPipeline(deps);
		const first = await seedDelivery(deps, p, { status: "dead" });
		const retryOfSame = newId("dlv");
		await deps.db.insert(deliveries).values({
			id: retryOfSame,
			eventId: first.eventId,
			destinationId: p.destination.id,
			projectId: p.project.id,
			kind: "replay",
			status: "dead",
			attemptCount: 3,
			createdAt: deps.now(),
		});
		const api = await adminApp(deps, { role: "operator" });
		const body = await (
			await api.request("POST", "/failures/replay", {
				delivery_ids: [first.deliveryId, retryOfSame],
				reason,
			})
		).json<BulkReplayResult>();
		expect(body.replayed.map((r) => r.delivery_id)).toEqual([first.deliveryId]);
		expect(body.skipped).toEqual([
			{ delivery_id: retryOfSame, reason: "replay_in_progress" },
		]);
	});

	it("writes nothing and creates no audit row when every id is skipped", async () => {
		const deps = testDeps();
		await seedPipeline(deps);
		const api = await adminApp(deps, { role: "operator" });
		const missing = newId("dlv");
		const body = await (
			await api.request("POST", "/failures/replay", {
				delivery_ids: [missing],
				reason,
			})
		).json<BulkReplayResult>();
		expect(body).toEqual({
			replayed: [],
			skipped: [{ delivery_id: missing, reason: "not_found" }],
		});
		const audits = (await deps.db.query.auditLogs.findMany()).filter(
			(a) => a.actorEmail === api.email && a.action === "delivery.replayed",
		);
		expect(audits).toEqual([]);
	});

	it("fails the whole request with 503 when R2 head errors", async () => {
		const base = testDeps({ queue: recordingQueue() });
		const p = await seedPipeline(base);
		const inline = await seedDelivery(base, p, { status: "dead" });
		const inR2 = await seedDelivery(base, p, {
			status: "dead",
			body: new Uint8Array(),
			event: { r2Key: `payloads/${crypto.randomUUID()}` },
		});
		const op = await adminApp(base, { role: "operator" });
		clearAccessKeyCache(); // second app minted fresh keys under the same kid
		const api = await adminApp(
			faultyDeps(base, { r2: [{ match: /^head / }] }),
			{
				email: op.email,
			},
		);
		const res = await api.request("POST", "/failures/replay", {
			delivery_ids: [inline.deliveryId, inR2.deliveryId],
			reason,
		});
		expect(res.status).toBe(503);
		expect(await eventDeliveries(base, inline.eventId)).toHaveLength(1);
		expect((base.queue as RecordingQueue).sent).toEqual([]);
	});
});
