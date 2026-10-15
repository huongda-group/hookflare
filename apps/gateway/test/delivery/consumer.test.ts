import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../../src/core/crypto";
import {
	deliveries,
	deliveryAttempts,
	destinations,
} from "../../src/core/db/schema";
import { DnsError } from "../../src/core/dns";
import { createLogger } from "../../src/core/log";
import { aad } from "../../src/core/secrets";
import { signWebhook } from "../../src/core/sign";
import { clearSsrfCache } from "../../src/core/ssrf";
import {
	handleDeliveryBatch,
	processDelivery,
	readSnippet,
} from "../../src/delivery/consumer";
import type { Deps } from "../../src/deps";
import { type RecordingQueue, recordingQueue, testDeps } from "../helpers/deps";
import { faultyDeps } from "../helpers/faults";
import { fakeBatch, fakeMessage } from "../helpers/queue";
import {
	seedDelivery,
	seedPipeline,
	TEST_SIGNING_SECRET,
} from "../helpers/seed";

const logger = createLogger({ LOG_LEVEL: "error" });

function fetchReturning(make: () => Response | Promise<Response>) {
	return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
		make(),
	) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

async function state(deps: Deps, deliveryId: string) {
	const [delivery] = await deps.db
		.select()
		.from(deliveries)
		.where(eq(deliveries.id, deliveryId));
	const attempts = await deps.db
		.select()
		.from(deliveryAttempts)
		.where(eq(deliveryAttempts.deliveryId, deliveryId));
	return { delivery, attempts };
}

function endlessBody(onCancel = () => {}): ReadableStream<Uint8Array> {
	return new ReadableStream({
		pull: (c) => c.enqueue(new Uint8Array(1024).fill(0x61)),
		cancel: onCancel,
	});
}

describe("processDelivery", () => {
	beforeEach(() => {
		clearSsrfCache();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("delivers a 2xx, records the attempt, and signs the request", async () => {
		const fetchMock = fetchReturning(() => new Response("ok", { status: 200 }));
		const deps = testDeps({ fetch: fetchMock });
		const p = await seedPipeline(deps);
		const { eventId, deliveryId } = await seedDelivery(deps, p);

		expect(await processDelivery(deps, deliveryId, logger)).toEqual({
			action: "ack",
		});

		const { delivery, attempts } = await state(deps, deliveryId);
		expect(delivery).toMatchObject({
			status: "delivered",
			attemptCount: 1,
			lastHttpStatus: 200,
			lastError: null,
		});
		expect(delivery.completedAt).toBeTypeOf("number");
		expect(attempts).toHaveLength(1);
		expect(attempts[0]).toMatchObject({
			attemptNo: 1,
			httpStatus: 200,
			errorKind: null,
			responseSnippet: "ok",
		});
		expect(attempts[0].id).toMatch(/^att_/);
		expect(attempts[0].durationMs).toBeGreaterThanOrEqual(0);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(p.destination.url);
		expect(init).toMatchObject({ method: "POST", redirect: "manual" });
		expect(init.signal).toBeInstanceOf(AbortSignal);
		const headers = new Headers(init.headers);
		expect(headers.get("webhook-id")).toBe(deliveryId);
		expect(headers.get("x-webhook-event-id")).toBe(eventId);
		const body = new Uint8Array(
			init.body as ArrayBuffer,
		) as Uint8Array<ArrayBuffer>;
		const expected = await signWebhook({
			id: deliveryId,
			timestampSec: Number(headers.get("webhook-timestamp")),
			body,
			secret: TEST_SIGNING_SECRET,
		});
		expect(headers.get("webhook-signature")).toBe(expected);
	});

	it("forwards binary bodies byte-for-byte", async () => {
		const fetchMock = fetchReturning(() => new Response(null, { status: 204 }));
		const deps = testDeps({ fetch: fetchMock });
		const p = await seedPipeline(deps);
		const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe]);
		const { deliveryId } = await seedDelivery(deps, p, {
			body: bytes,
			contentType: "application/gzip",
		});
		await processDelivery(deps, deliveryId, logger);
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(bytes);
		const headers = new Headers(init.headers);
		expect(headers.get("content-type")).toBe("application/gzip");
		// The signature covers the exact bytes, not a text re-encoding.
		expect(headers.get("webhook-signature")).toBe(
			await signWebhook({
				id: deliveryId,
				timestampSec: Number(headers.get("webhook-timestamp")),
				body: bytes,
				secret: TEST_SIGNING_SECRET,
			}),
		);
	});

	it.each([
		[
			"a 400",
			() => new Response("", { status: 400 }),
			"http_4xx",
			400,
			"HTTP 400",
		],
		[
			"a 404",
			() => new Response("", { status: 404 }),
			"http_4xx",
			404,
			"HTTP 404",
		],
		[
			"a redirect (not followed)",
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "https://elsewhere.example.com" },
				}),
			"http_3xx",
			302,
			"HTTP 302",
		],
	])(
		"marks %s failed_final",
		async (_label, make, errorKind, httpStatus, lastError) => {
			const deps = testDeps({ fetch: fetchReturning(make) });
			const p = await seedPipeline(deps);
			const { deliveryId } = await seedDelivery(deps, p);
			await processDelivery(deps, deliveryId, logger);
			const { delivery, attempts } = await state(deps, deliveryId);
			expect(delivery).toMatchObject({
				status: "failed_final",
				attemptCount: 1,
				lastHttpStatus: httpStatus,
				lastError,
			});
			expect(attempts[0]).toMatchObject({ errorKind, httpStatus });
		},
	);

	it("fails a disabled destination without an attempt or a request", async () => {
		const fetchMock = fetchReturning(() => new Response("ok"));
		const deps = testDeps({ fetch: fetchMock });
		const p = await seedPipeline(deps, { destination: { status: "disabled" } });
		const { deliveryId } = await seedDelivery(deps, p);
		expect(await processDelivery(deps, deliveryId, logger)).toEqual({
			action: "ack",
		});
		const { delivery, attempts } = await state(deps, deliveryId);
		expect(delivery).toMatchObject({
			status: "failed_final",
			attemptCount: 0,
			lastError: "destination_disabled",
		});
		expect(attempts).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fails an SSRF-blocked destination without an attempt", async () => {
		const fetchMock = fetchReturning(() => new Response("ok"));
		const deps = testDeps({
			fetch: fetchMock,
			resolveDns: vi.fn(async () => ["10.0.0.5"]),
		});
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p);
		await processDelivery(deps, deliveryId, logger);
		const { delivery, attempts } = await state(deps, deliveryId);
		expect(delivery).toMatchObject({
			status: "failed_final",
			lastError: "ssrf_blocked: private_address",
		});
		expect(attempts).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fails without an attempt or a request when the signing secret cannot be decrypted", async () => {
		const fetchMock = fetchReturning(() => new Response("ok"));
		const deps = testDeps({ fetch: fetchMock });
		const p = await seedPipeline(deps, {
			destination: { signingSecretEnc: "v1.corrupt.ciphertext" },
		});
		const { deliveryId } = await seedDelivery(deps, p);
		expect(await processDelivery(deps, deliveryId, logger)).toEqual({
			action: "ack",
		});
		const { delivery, attempts } = await state(deps, deliveryId);
		expect(delivery).toMatchObject({
			status: "failed_final",
			attemptCount: 0,
			lastError: "signing_failed",
		});
		expect(attempts).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("calls the backend once for a duplicate message", async () => {
		const fetchMock = fetchReturning(() => new Response("ok"));
		const deps = testDeps({ fetch: fetchMock });
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p);
		const results = await Promise.all([
			processDelivery(deps, deliveryId, logger),
			processDelivery(deps, deliveryId, logger),
		]);
		expect(results).toEqual([{ action: "ack" }, { action: "ack" }]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect((await state(deps, deliveryId)).attempts).toHaveLength(1);
	});

	it("also processes a delivery still in pending (mark-queued failed)", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p, { status: "pending" });
		await processDelivery(deps, deliveryId, logger);
		expect((await state(deps, deliveryId)).delivery.status).toBe("delivered");
	});

	it("acks an unknown delivery", async () => {
		expect(
			await processDelivery(
				testDeps(),
				"dlv_01JAAAAAAAAAAAAAAAAAAAAAAA",
				logger,
			),
		).toEqual({ action: "ack" });
	});

	it("keeps the HTTP status when the response body errors", async () => {
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(c) {
				if (pulls++ === 0) {
					c.enqueue(new TextEncoder().encode("partial"));
				} else {
					c.error(new Error("connection reset"));
				}
			},
		});
		const deps = testDeps({
			fetch: fetchReturning(() => new Response(body, { status: 200 })),
		});
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p);
		await processDelivery(deps, deliveryId, logger);
		const { delivery, attempts } = await state(deps, deliveryId);
		expect(delivery.status).toBe("delivered");
		expect(attempts[0].responseSnippet).toBe("partial");
	});

	it("sends two signatures while the previous signing secret is in grace", async () => {
		const fetch = vi.fn(async () => new Response("ok", { status: 200 }));
		const deps = testDeps({
			fetch: fetch as unknown as typeof globalThis.fetch,
		});
		const p = await seedPipeline(deps);
		const prev = "whsec_cHJldmlvdXMtc2VjcmV0LWJ5dGVzLTMyLWxvbmchIQ==";
		await deps.db
			.update(destinations)
			.set({
				signingSecretPrevEnc: await encryptSecret(
					deps.env,
					prev,
					aad.destinationPrev(p.destination.id),
				),
				signingSecretPrevExpiresAt: deps.now() + 3_600_000,
			})
			.where(eq(destinations.id, p.destination.id));
		const { deliveryId } = await seedDelivery(deps, p);
		await processDelivery(deps, deliveryId, createLogger(deps.env, {}));
		const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		const headers = new Headers(init.headers);
		const sigs = headers.get("webhook-signature")?.split(" ") ?? [];
		expect(sigs).toHaveLength(2);
		const ts = Number(headers.get("webhook-timestamp"));
		const body = init.body as Uint8Array;
		expect(sigs[0]).toBe(
			await signWebhook({
				id: deliveryId,
				timestampSec: ts,
				body,
				secret: TEST_SIGNING_SECRET,
			}),
		);
		expect(sigs[1]).toBe(
			await signWebhook({
				id: deliveryId,
				timestampSec: ts,
				body,
				secret: prev,
			}),
		);
	});
});

describe("readSnippet", () => {
	it("caps the response snippet at 2 KB", async () => {
		const onCancel = vi.fn();
		const snippet = await readSnippet(new Response(endlessBody(onCancel)));
		expect(snippet).toHaveLength(2048);
		// Stop pulling from the backend once the cap is reached.
		await vi.waitFor(() => expect(onCancel).toHaveBeenCalled());
	});

	it("returns null for an empty body and decodes invalid UTF-8 lossily", async () => {
		expect(await readSnippet(new Response(null, { status: 204 }))).toBeNull();
		expect(await readSnippet(new Response(new Uint8Array([0x68, 0xff])))).toBe(
			"h�",
		);
	});
});

const T0 = 1_800_000_000_000;

function clocked(overrides: Partial<Deps> = {}) {
	let t = T0;
	const deps = testDeps({
		now: () => t,
		queue: recordingQueue(),
		...overrides,
	});
	return {
		deps,
		queue: deps.queue as RecordingQueue,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

describe("processDelivery retries (M2)", () => {
	beforeEach(() => {
		clearSsrfCache();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(Math, "random").mockReturnValue(0.5);
	});
	afterEach(() => vi.restoreAllMocks());

	it.each([
		["408", () => new Response("", { status: 408 }), "http_4xx"],
		["429", () => new Response("", { status: 429 }), "http_4xx"],
		["500", () => new Response("", { status: 500 }), "http_5xx"],
		["503", () => new Response("", { status: 503 }), "http_5xx"],
		[
			"timeout",
			() => Promise.reject(new DOMException("t", "TimeoutError")),
			"timeout",
		],
		["network", () => Promise.reject(new TypeError("lost")), "network"],
	] as const)(
		"%s → retrying + delayed message",
		async (_l, make, errorKind) => {
			const { deps, queue } = clocked({ fetch: fetchReturning(make) });
			const p = await seedPipeline(deps);
			const { deliveryId } = await seedDelivery(deps, p);
			expect(await processDelivery(deps, deliveryId, logger)).toEqual({
				action: "ack",
			});
			const { delivery, attempts } = await state(deps, deliveryId);
			expect(delivery).toMatchObject({
				status: "retrying",
				attemptCount: 1,
				nextAttemptAt: T0 + 30_000,
				enqueuedAt: T0,
				leaseUntil: null,
				completedAt: null,
			});
			expect(attempts[0].errorKind).toBe(errorKind);
			expect(queue.sent).toEqual([{ deliveryId }]);
			expect(queue.delays).toEqual([30]);
		},
	);

	it("goes dead when the budget is exhausted", async () => {
		const { deps, queue } = clocked({
			fetch: fetchReturning(() => new Response("", { status: 503 })),
		});
		const p = await seedPipeline(deps, { destination: { maxAttempts: 3 } });
		const { deliveryId } = await seedDelivery(deps, p, {
			delivery: { status: "retrying", attemptCount: 2, nextAttemptAt: T0 },
		});
		await processDelivery(deps, deliveryId, logger);
		expect((await state(deps, deliveryId)).delivery).toMatchObject({
			status: "dead",
			attemptCount: 3,
			completedAt: T0,
			nextAttemptAt: null,
		});
		expect(queue.sent).toHaveLength(0);
	});

	it("goes dead when max_attempts was lowered below attempt_count", async () => {
		const { deps } = clocked({
			fetch: fetchReturning(() => new Response("", { status: 503 })),
		});
		const p = await seedPipeline(deps, { destination: { maxAttempts: 3 } });
		const { deliveryId } = await seedDelivery(deps, p, {
			delivery: { status: "retrying", attemptCount: 5, nextAttemptAt: T0 },
		});
		await processDelivery(deps, deliveryId, logger);
		expect((await state(deps, deliveryId)).delivery.status).toBe("dead");
	});

	it("uses the destination's backoff and honors Retry-After on 429", async () => {
		const { deps, queue } = clocked({
			fetch: fetchReturning(
				() =>
					new Response("", {
						status: 429,
						headers: { "retry-after": "99999" },
					}),
			),
		});
		const p = await seedPipeline(deps, {
			destination: { backoffBaseS: 100, backoffMaxS: 600 },
		});
		const { deliveryId } = await seedDelivery(deps, p);
		await processDelivery(deps, deliveryId, logger);
		expect(queue.delays).toEqual([600]);
		expect((await state(deps, deliveryId)).delivery.nextAttemptAt).toBe(
			T0 + 600_000,
		);
	});

	it.each([
		[1, 60],
		[3, 240],
		[10, 3600],
	])(
		"D1 load failure → infra retry (msg.attempts %i → %i s), no attempt",
		async (n, delay) => {
			const { deps: base } = clocked();
			const p = await seedPipeline(base);
			const { deliveryId } = await seedDelivery(base, p);
			const deps = faultyDeps(base, {
				d1: [{ match: /from "deliveries" inner join/ }],
			});
			expect(await processDelivery(deps, deliveryId, logger, n)).toEqual({
				action: "retry",
				delaySeconds: delay,
			});
			expect((await state(base, deliveryId)).delivery).toMatchObject({
				status: "queued",
				attemptCount: 0,
			});
		},
	);

	it("R2 get failure → infra retry; missing object → failed_final payload_missing", async () => {
		const fetchMock = fetchReturning(() => new Response("ok"));
		const { deps: base } = clocked({ fetch: fetchMock });
		const p = await seedPipeline(base);
		const broken = await seedDelivery(base, p, {
			event: {
				r2Key: "events/2026/10/15/evt_missing",
				bodyInline: new Uint8Array(),
			},
		});
		const deps = faultyDeps(base, { r2: [{ match: /^get / }] });
		expect(
			await processDelivery(deps, broken.deliveryId, logger),
		).toMatchObject({
			action: "retry",
		});
		expect((await state(base, broken.deliveryId)).delivery.status).toBe(
			"queued",
		);

		expect(await processDelivery(base, broken.deliveryId, logger)).toEqual({
			action: "ack",
		});
		expect((await state(base, broken.deliveryId)).delivery).toMatchObject({
			status: "failed_final",
			lastError: "payload_missing",
			attemptCount: 0,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("delivers an R2 payload byte-for-byte", async () => {
		const fetchMock = fetchReturning(() => new Response("ok"));
		const { deps } = clocked({ fetch: fetchMock });
		const p = await seedPipeline(deps);
		const body = new Uint8Array(100_000).fill(9);
		const key = `events/2026/10/15/evt_${crypto.randomUUID()}`;
		await deps.payloads.put(key, body);
		const { deliveryId } = await seedDelivery(deps, p, {
			body,
			event: { r2Key: key, bodyInline: new Uint8Array() },
		});
		await processDelivery(deps, deliveryId, logger);
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(body);
	});

	it("DNS resolver error → infra retry without an attempt", async () => {
		const { deps } = clocked({
			resolveDns: vi.fn(async () => Promise.reject(new DnsError("SERVFAIL"))),
		});
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p);
		expect(await processDelivery(deps, deliveryId, logger)).toMatchObject({
			action: "retry",
		});
		expect((await state(deps, deliveryId)).delivery).toMatchObject({
			status: "queued",
			attemptCount: 0,
		});
	});

	it("defers a retrying delivery that is not due yet, without a request", async () => {
		const fetchMock = fetchReturning(() => new Response("ok"));
		const { deps, advance } = clocked({ fetch: fetchMock });
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p, {
			delivery: {
				status: "retrying",
				attemptCount: 1,
				nextAttemptAt: T0 + 29_500,
			},
		});
		expect(await processDelivery(deps, deliveryId, logger)).toEqual({
			action: "retry",
			delaySeconds: 30,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect((await state(deps, deliveryId)).delivery).toMatchObject({
			status: "retrying",
			attemptCount: 1,
		});
		advance(29_500);
		expect(await processDelivery(deps, deliveryId, logger)).toEqual({
			action: "ack",
		});
		expect((await state(deps, deliveryId)).delivery.status).toBe("delivered");
	});

	it("parks a delivery of a paused destination without a request", async () => {
		const fetchMock = fetchReturning(() => new Response("ok"));
		const { deps } = clocked({ fetch: fetchMock });
		const p = await seedPipeline(deps, { destination: { status: "paused" } });
		const { deliveryId } = await seedDelivery(deps, p);
		expect(await processDelivery(deps, deliveryId, logger)).toEqual({
			action: "ack",
		});
		expect((await state(deps, deliveryId)).delivery.status).toBe("paused");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("re-acquires an expired lease and skips a live one", async () => {
		const fetchMock = fetchReturning(() => new Response("ok"));
		const { deps } = clocked({ fetch: fetchMock });
		const p = await seedPipeline(deps);
		const expired = await seedDelivery(deps, p, {
			delivery: { status: "in_flight", leaseUntil: T0 - 1 },
		});
		const live = await seedDelivery(deps, p, {
			delivery: { status: "in_flight", leaseUntil: T0 + 60_000 },
		});
		await processDelivery(deps, expired.deliveryId, logger);
		await processDelivery(deps, live.deliveryId, logger);
		expect((await state(deps, expired.deliveryId)).delivery.status).toBe(
			"delivered",
		);
		expect((await state(deps, live.deliveryId)).delivery.status).toBe(
			"in_flight",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("record failure → infra retry; the retry re-sends with the same webhook-id", async () => {
		const fetchMock = fetchReturning(() => new Response("ok"));
		const { deps: base, advance } = clocked({ fetch: fetchMock });
		const p = await seedPipeline(base);
		const { deliveryId } = await seedDelivery(base, p);
		const deps = faultyDeps(base, {
			d1: [{ match: /insert into "delivery_attempts"/, on: { nth: 1 } }],
		});
		expect(await processDelivery(deps, deliveryId, logger)).toEqual({
			action: "retry",
			delaySeconds: 60,
		});
		expect((await state(base, deliveryId)).delivery).toMatchObject({
			status: "in_flight",
			leaseUntil: T0 + 10_000 + 30_000,
		});
		advance(60_000);
		await processDelivery(deps, deliveryId, logger, 2);
		expect((await state(base, deliveryId)).delivery).toMatchObject({
			status: "delivered",
			attemptCount: 1,
		});
		const ids = fetchMock.mock.calls.map((c) =>
			new Headers((c[1] as RequestInit).headers).get("webhook-id"),
		);
		expect(ids).toEqual([deliveryId, deliveryId]);
	});

	it("a stale worker writes nothing when its lease was taken over", async () => {
		const { deps } = clocked();
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p);
		deps.fetch = fetchReturning(async () => {
			await deps.db
				.update(deliveries)
				.set({ leaseUntil: T0 + 999_999 })
				.where(eq(deliveries.id, deliveryId));
			return new Response("ok");
		});
		expect(await processDelivery(deps, deliveryId, logger)).toEqual({
			action: "ack",
		});
		const { delivery, attempts } = await state(deps, deliveryId);
		expect(attempts).toHaveLength(0);
		expect(delivery).toMatchObject({ status: "in_flight", attemptCount: 0 });
	});

	it("reschedule failure → msg.retry with the backoff delay", async () => {
		const { deps: base } = clocked({
			fetch: fetchReturning(() => new Response("", { status: 503 })),
		});
		const p = await seedPipeline(base);
		const { deliveryId } = await seedDelivery(base, p);
		const deps = faultyDeps(base, { queue: [{ match: /^send$/ }] });
		expect(await processDelivery(deps, deliveryId, logger)).toEqual({
			action: "retry",
			delaySeconds: 30,
		});
		expect((await state(base, deliveryId)).delivery.status).toBe("retrying");
	});
});

describe("handleDeliveryBatch", () => {
	it("acks, retries with a delay, and drops malformed messages", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { deps: base } = clocked();
		const p = await seedPipeline(base);
		const ok = await seedDelivery(base, p);
		const deps = faultyDeps(base, {
			d1: [{ match: /from "deliveries" inner join/, on: { nth: 2 } }],
		});
		const good = fakeMessage({ deliveryId: ok.deliveryId });
		const infra = fakeMessage({ deliveryId: ok.deliveryId }, 2);
		const bad = fakeMessage({ nope: 1 });
		await handleDeliveryBatch(fakeBatch("hookflare-deliveries", [good]), deps);
		await handleDeliveryBatch(
			fakeBatch("hookflare-deliveries", [infra, bad]),
			deps,
		);
		expect(good.ack).toHaveBeenCalled();
		expect(infra.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
		expect(bad.ack).toHaveBeenCalled();
	});

	it("retries only the message whose processing throws unexpectedly", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { deps: base } = clocked();
		const p = await seedPipeline(base);
		const { deliveryId } = await seedDelivery(base, p);
		const deps: Deps = {
			...base,
			now: () => {
				throw new Error("boom");
			},
		};
		const broken = fakeMessage({ deliveryId }, 3);
		const bad = fakeMessage({ nope: 1 });
		await handleDeliveryBatch(
			fakeBatch("hookflare-deliveries", [broken, bad]),
			deps,
		);
		expect(broken.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
		expect(bad.ack).toHaveBeenCalled();
	});
});
