import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { deliveries, webhookEvents } from "../../src/core/db/schema";
import { clearSourceCache } from "../../src/core/source-cache";
import type { Deps } from "../../src/deps";
import {
	type RecordingQueue,
	recordingQueue,
	testDeps,
	withFailingBatch,
} from "../helpers/deps";
import { denyAllLimiter, testEnv } from "../helpers/env";
import { seedPipeline, TEST_SOURCE_SECRET } from "../helpers/seed";

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

async function hmacHex(data: Uint8Array): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(TEST_SOURCE_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, data))]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

const hmacSource = {
	authType: "hmac" as const,
	authConfig: { header: "x-sig", algorithm: "sha256", encoding: "hex" },
};

describe("POST /in/:sourceId", () => {
	beforeEach(() => {
		clearSourceCache();
		vi.spyOn(console, "log").mockImplementation(() => {});
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
});
