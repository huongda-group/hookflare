import { eq } from "drizzle-orm";
import {
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import { createApp } from "../../src/app";
import { encryptSecret } from "../../src/core/crypto";
import { deliveries, sources, webhookEvents } from "../../src/core/db/schema";
import { aad } from "../../src/core/secrets";
import { clearSourceCache } from "../../src/core/source-cache";
import type { Deps } from "../../src/deps";
import {
	type RecordingQueue,
	recordingQueue,
	testDeps,
	withFailingBatch,
} from "../helpers/deps";
import { denyAllLimiter, testEnv } from "../helpers/env";
import { faultyDeps } from "../helpers/faults";
import {
	seedDelivery,
	seedPipeline,
	TEST_SOURCE_SECRET,
} from "../helpers/seed";

function post(
	deps: Deps,
	path: string,
	body?: BodyInit,
	headers: Record<string, string> = {},
) {
	return createApp({ createDeps: () => deps }).request(
		path,
		{ method: "POST", body, headers },
		deps.env,
	);
}

async function eventsOf(deps: Deps, sourceId: string) {
	return deps.db
		.select()
		.from(webhookEvents)
		.where(eq(webhookEvents.sourceId, sourceId));
}

async function hmacHex(
	data: Uint8Array,
	secret = TEST_SOURCE_SECRET,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, data))]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

let logSpy: MockInstance<typeof console.log>;

function loggedLines(): Record<string, unknown>[] {
	return logSpy.mock.calls.map((call) => JSON.parse(call[0] as string));
}

function rejection(): Record<string, unknown> | undefined {
	return loggedLines().find((l) => l.msg === "ingress.rejected");
}

const hmacSource = {
	authType: "hmac" as const,
	authConfig: { header: "x-sig", algorithm: "sha256", encoding: "hex" },
};

describe("POST /in/:sourceId", () => {
	beforeEach(() => {
		clearSourceCache();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("stores the event, creates a queued delivery, enqueues it, and returns 202", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps, { source: hmacSource });
		const body = new TextEncoder().encode('{"id":"evt_provider_1"}');
		const res = await post(deps, `/in/${p.source.id}`, body, {
			"content-type": "application/json",
			"x-sig": await hmacHex(body),
			authorization: "Bearer leak",
			"cf-connecting-ip": "1.2.3.4",
			"proxy-authorization": "p",
		});
		expect(res.status).toBe(202);
		const { event_id } = (await res.json()) as { event_id: string };
		expect(event_id).toMatch(/^evt_/);

		const [event] = await eventsOf(deps, p.source.id);
		expect(event.id).toBe(event_id);
		expect(new Uint8Array(event.bodyInline as Uint8Array)).toEqual(body);
		expect(event.sizeBytes).toBe(body.byteLength);
		expect(event.contentType).toBe("application/json");
		expect(event.headersJson["x-sig"]).toBe("[REDACTED]");
		expect(event.headersJson.authorization).toBe("[REDACTED]");
		expect(event.headersJson["cf-connecting-ip"]).toBeUndefined();
		expect(event.headersJson["proxy-authorization"]).toBeUndefined();
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
		expect(event.payloadSha256).toBe(
			[...digest].map((b) => b.toString(16).padStart(2, "0")).join(""),
		);

		const [delivery] = await deps.db
			.select()
			.from(deliveries)
			.where(eq(deliveries.eventId, event_id));
		expect(delivery).toMatchObject({
			status: "queued",
			kind: "initial",
			attemptCount: 0,
			destinationId: p.destination.id,
		});
		expect(delivery.enqueuedAt).toBeTypeOf("number");
		expect((deps.queue as RecordingQueue).sent).toEqual([
			{ deliveryId: delivery.id },
		]);
	});

	it("accepts an empty body", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps, { source: hmacSource });
		const res = await post(deps, `/in/${p.source.id}`, undefined, {
			"x-sig": await hmacHex(new Uint8Array()),
		});
		expect(res.status).toBe(202);
		const [event] = await eventsOf(deps, p.source.id);
		expect(event.sizeBytes).toBe(0);
	});

	it("extracts and stores the provider event id", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps, {
			source: { eventIdFrom: "json_path", eventIdSelector: "$.data.id" },
		});
		await post(deps, `/in/${p.source.id}`, '{"data":{"id":"pi_123"}}');
		const [event] = await eventsOf(deps, p.source.id);
		expect(event.providerEventId).toBe("pi_123");
	});

	it.each([
		["a malformed id", "/in/not-an-id"],
		["an unknown source", "/in/src_01JAAAAAAAAAAAAAAAAAAAAAAA"],
	])("returns 404 for %s", async (_label, path) => {
		const res = await post(testDeps(), path, "{}");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "not_found" });
	});

	it("returns 404 for a disabled source or project", async () => {
		const deps = testDeps();
		const disabled = await seedPipeline(deps, {
			source: { status: "disabled" },
		});
		expect((await post(deps, `/in/${disabled.source.id}`, "{}")).status).toBe(
			404,
		);
		const p = await seedPipeline(deps);
		await deps.env.DB.prepare(
			"UPDATE projects SET status = 'disabled' WHERE id = ?",
		)
			.bind(p.project.id)
			.run();
		expect((await post(deps, `/in/${p.source.id}`, "{}")).status).toBe(404);
	});

	it("serves the cached bundle for 30 s", async () => {
		let now = 1_800_000_000_000;
		const deps = testDeps({ now: () => now });
		const p = await seedPipeline(deps);
		expect((await post(deps, `/in/${p.source.id}`, "{}")).status).toBe(202);
		await deps.env.DB.prepare(
			"UPDATE sources SET status = 'disabled' WHERE id = ?",
		)
			.bind(p.source.id)
			.run();
		now += 29_000;
		expect((await post(deps, `/in/${p.source.id}`, "{}")).status).toBe(202);
		now += 2_000;
		expect((await post(deps, `/in/${p.source.id}`, "{}")).status).toBe(404);
	});

	it("returns 503 and does not cache when the source lookup fails", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const broken: Deps = {
			...deps,
			db: new Proxy(deps.db, {
				get(target, prop, receiver) {
					if (prop === "select" || prop === "query")
						throw new Error("D1_ERROR: simulated outage");
					return Reflect.get(target, prop, receiver);
				},
			}),
		};
		const res = await post(broken, `/in/${p.source.id}`, "{}");
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "unavailable" });
		expect((await post(deps, `/in/${p.source.id}`, "{}")).status).toBe(202);
	});

	it("returns 429 when the limiter rejects", async () => {
		const deps = testDeps({
			env: testEnv({ INGRESS_LIMITER: denyAllLimiter }),
		});
		const p = await seedPipeline(deps);
		const res = await post(deps, `/in/${p.source.id}`, "{}");
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: "rate_limited" });
	});

	it("returns 413 above max_body_bytes and stores nothing", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps, { source: { maxBodyBytes: 10 } });
		const res = await post(deps, `/in/${p.source.id}`, "x".repeat(11));
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "payload_too_large" });
		expect(rejection()).toMatchObject({ reason: "too_large" });
		expect(await eventsOf(deps, p.source.id)).toHaveLength(0);
	});

	it("returns 401 for a bad signature and stores nothing", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps, { source: hmacSource });
		const res = await post(deps, `/in/${p.source.id}`, "{}", {
			"x-sig": "00".repeat(32),
		});
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "unauthorized" });
		expect(rejection()).toMatchObject({
			reason: "unauthorized",
			verify_failure: "mismatch",
		});
		expect(await eventsOf(deps, p.source.id)).toHaveLength(0);
	});

	it("returns 400 when the client aborts mid-upload and stores nothing", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new Error("client disconnected"));
			},
		});
		const res = await post(deps, `/in/${p.source.id}`, body);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid_request" });
		expect(rejection()).toMatchObject({ reason: "body_read_failed" });
		expect(await eventsOf(deps, p.source.id)).toHaveLength(0);
	});

	it("returns 503 when the D1 write fails and enqueues nothing", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const queue = recordingQueue();
		const res = await post(
			{ ...deps, db: withFailingBatch(deps.db), queue },
			`/in/${p.source.id}`,
			"{}",
		);
		expect(res.status).toBe(503);
		expect(queue.sent).toHaveLength(0);
		expect(await eventsOf(deps, p.source.id)).toHaveLength(0);
	});

	it("returns 503 when the queue fails and leaves the delivery pending", async () => {
		const deps = testDeps({ queue: recordingQueue({ fail: true }) });
		const p = await seedPipeline(deps);
		const res = await post(deps, `/in/${p.source.id}`, "{}");
		expect(res.status).toBe(503);
		const [event] = await eventsOf(deps, p.source.id);
		const [delivery] = await deps.db
			.select()
			.from(deliveries)
			.where(eq(deliveries.eventId, event.id));
		expect(delivery.status).toBe("pending");
		expect(delivery.enqueuedAt).toBeNull();
	});

	const withEventId = {
		eventIdFrom: "header" as const,
		eventIdSelector: "x-event-id",
	};
	const big = (n: number) => new Uint8Array(n).fill(0x61);

	async function deliveriesOf(deps: Deps, eventId: string) {
		return deps.db
			.select()
			.from(deliveries)
			.where(eq(deliveries.eventId, eventId));
	}

	it("stores a body above 64 KiB in R2 with an empty inline body", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const body = big(200_000);
		const res = await post(deps, `/in/${p.source.id}`, body, {
			"content-type": "application/octet-stream",
		});
		expect(res.status).toBe(202);
		const [event] = await eventsOf(deps, p.source.id);
		expect(event.r2Key).toMatch(/^events\/\d{4}\/\d{2}\/\d{2}\/evt_/);
		expect(event.bodyInline.byteLength).toBe(0);
		expect(event.sizeBytes).toBe(200_000);
		const obj = await deps.payloads.get(event.r2Key as string);
		expect(new Uint8Array(await (obj as R2ObjectBody).arrayBuffer())).toEqual(
			body,
		);
	});

	it("keeps exactly 64 KiB inline and moves 64 KiB + 1 to R2", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		await post(deps, `/in/${p.source.id}`, big(65_536));
		await post(deps, `/in/${p.source.id}`, big(65_537));
		const events = (await eventsOf(deps, p.source.id)).sort(
			(a, b) => a.sizeBytes - b.sizeBytes,
		);
		expect(
			events.map((e) => [
				e.sizeBytes,
				e.r2Key === null,
				e.bodyInline.byteLength,
			]),
		).toEqual([
			[65_536, true, 65_536],
			[65_537, false, 0],
		]);
	});

	it("caps at 1 MiB by default and at max_body_bytes when set", async () => {
		const deps = testDeps();
		const def = await seedPipeline(deps);
		expect(
			(await post(deps, `/in/${def.source.id}`, big(1_048_577))).status,
		).toBe(413);
		const large = await seedPipeline(deps, {
			source: { maxBodyBytes: 10_485_760 },
		});
		expect(
			(await post(deps, `/in/${large.source.id}`, big(2_000_000))).status,
		).toBe(202);
	});

	it("returns 503 and stores nothing when the R2 put fails", async () => {
		const deps = faultyDeps(testDeps(), { r2: [{ match: /^put / }] });
		const p = await seedPipeline(deps);
		expect((await post(deps, `/in/${p.source.id}`, big(100_000))).status).toBe(
			503,
		);
		expect(await eventsOf(deps, p.source.id)).toHaveLength(0);
		expect((deps.queue as RecordingQueue).sent).toHaveLength(0);
	});

	it("returns 503 and deletes the R2 object when the D1 write fails", async () => {
		const deps = faultyDeps(testDeps(), {
			d1: [{ match: /insert into "webhook_events"/ }],
		});
		const p = await seedPipeline(testDeps());
		const res = await post(deps, `/in/${p.source.id}`, big(100_000));
		expect(res.status).toBe(503);
		const put = deps.r2Log.find((l) => l.startsWith("put "));
		expect(deps.r2Log).toContain(`delete ${put?.slice(4)}`);
		expect(await deps.payloads.head(put?.slice(4) as string)).toBeNull();
	});

	it("returns 200 duplicate for a known provider event id and creates nothing", async () => {
		const queue = recordingQueue();
		const deps = testDeps({ queue });
		const p = await seedPipeline(deps, { source: withEventId });
		const first = await post(deps, `/in/${p.source.id}`, "{}", {
			"x-event-id": "e1",
		});
		const { event_id } = (await first.json()) as { event_id: string };
		const again = await post(deps, `/in/${p.source.id}`, "{}", {
			"x-event-id": "e1",
		});
		expect(again.status).toBe(200);
		expect(await again.json()).toEqual({ duplicate: true, event_id });
		expect(await eventsOf(deps, p.source.id)).toHaveLength(1);
		expect(await deliveriesOf(deps, event_id)).toHaveLength(1);
		expect(queue.sent).toHaveLength(1);
		expect(loggedLines().some((l) => l.msg === "ingress.duplicate")).toBe(true);
	});

	it("returns 200 for a large duplicate without touching R2", async () => {
		const deps = faultyDeps(testDeps(), {});
		const p = await seedPipeline(deps, { source: withEventId });
		await post(deps, `/in/${p.source.id}`, big(100_000), {
			"x-event-id": "e2",
		});
		const puts = deps.r2Log.length;
		const again = await post(deps, `/in/${p.source.id}`, big(100_000), {
			"x-event-id": "e2",
		});
		expect(again.status).toBe(200);
		expect(deps.r2Log).toHaveLength(puts);
	});

	it("returns 200 duplicate even when the first event's delivery failed", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps, { source: withEventId });
		const { eventId } = await seedDelivery(deps, p, {
			status: "failed_final",
			event: { providerEventId: "e3" },
		});
		const res = await post(deps, `/in/${p.source.id}`, "{}", {
			"x-event-id": "e3",
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ duplicate: true, event_id: eventId });
	});

	it("handles two concurrent duplicates: one event, no orphan R2 object", async () => {
		const deps = faultyDeps(testDeps(), {});
		const p = await seedPipeline(deps, { source: withEventId });
		const responses = await Promise.all([
			post(deps, `/in/${p.source.id}`, big(100_000), { "x-event-id": "race" }),
			post(deps, `/in/${p.source.id}`, big(100_000), { "x-event-id": "race" }),
		]);
		expect(responses.map((r) => r.status).sort()).toEqual([200, 202]);
		const events = await eventsOf(deps, p.source.id);
		expect(events).toHaveLength(1);
		const puts = deps.r2Log
			.filter((l) => l.startsWith("put "))
			.map((l) => l.slice(4));
		const deletes = deps.r2Log
			.filter((l) => l.startsWith("delete "))
			.map((l) => l.slice(7));
		expect(puts.filter((k) => !deletes.includes(k))).toEqual([events[0].r2Key]);
	});

	it("does not dedupe when the provider event id is absent", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps, { source: withEventId });
		await post(deps, `/in/${p.source.id}`, "{}");
		await post(deps, `/in/${p.source.id}`, "{}");
		expect(await eventsOf(deps, p.source.id)).toHaveLength(2);
	});

	it("does not dedupe the same provider event id across sources", async () => {
		const deps = testDeps();
		const a = await seedPipeline(deps, { source: withEventId });
		const b = await seedPipeline(deps, { source: withEventId });
		expect(
			(await post(deps, `/in/${a.source.id}`, "{}", { "x-event-id": "same" }))
				.status,
		).toBe(202);
		expect(
			(await post(deps, `/in/${b.source.id}`, "{}", { "x-event-id": "same" }))
				.status,
		).toBe(202);
	});

	it("stores a paused delivery and enqueues nothing for a paused destination", async () => {
		const queue = recordingQueue();
		const deps = testDeps({ queue });
		const p = await seedPipeline(deps, { destination: { status: "paused" } });
		const res = await post(deps, `/in/${p.source.id}`, "{}");
		expect(res.status).toBe(202);
		const { event_id } = (await res.json()) as { event_id: string };
		const [delivery] = await deliveriesOf(deps, event_id);
		expect(delivery.status).toBe("paused");
		expect(queue.sent).toHaveLength(0);
	});
});

describe("previous source secret", () => {
	const prev = "previous-source-secret-0123456789";

	async function seedWithPrev(deps: Deps, expiresAt: number) {
		const p = await seedPipeline(deps, { source: hmacSource });
		await deps.db
			.update(sources)
			.set({
				secretPrevEnc: await encryptSecret(
					deps.env,
					prev,
					aad.sourcePrev(p.source.id),
				),
				secretPrevExpiresAt: expiresAt,
			})
			.where(eq(sources.id, p.source.id));
		clearSourceCache();
		return p;
	}

	it("accepts it during grace and logs the match", async () => {
		const deps = testDeps({ queue: recordingQueue() });
		const p = await seedWithPrev(deps, deps.now() + 3_600_000);
		const body = new TextEncoder().encode('{"a":1}');
		const res = await post(deps, `/in/${p.source.id}`, body, {
			"content-type": "application/json",
			"x-sig": await hmacHex(body, prev),
		});
		expect(res.status).toBe(202);
		expect(
			loggedLines().some((l) => l.msg === "ingress.verified_with_prev_secret"),
		).toBe(true);
	});

	it("rejects it after grace", async () => {
		const deps = testDeps({ queue: recordingQueue() });
		const p = await seedWithPrev(deps, deps.now() - 1);
		const body = new TextEncoder().encode('{"a":1}');
		const res = await post(deps, `/in/${p.source.id}`, body, {
			"content-type": "application/json",
			"x-sig": await hmacHex(body, prev),
		});
		expect(res.status).toBe(401);
	});

	it("still accepts the current secret", async () => {
		const deps = testDeps({ queue: recordingQueue() });
		const p = await seedWithPrev(deps, deps.now() + 3_600_000);
		const body = new TextEncoder().encode('{"a":1}');
		const res = await post(deps, `/in/${p.source.id}`, body, {
			"content-type": "application/json",
			"x-sig": await hmacHex(body),
		});
		expect(res.status).toBe(202);
		expect(
			loggedLines().some((l) => l.msg === "ingress.verified_with_prev_secret"),
		).toBe(false);
	});
});
