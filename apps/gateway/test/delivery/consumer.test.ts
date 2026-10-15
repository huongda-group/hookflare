import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliveries, deliveryAttempts } from "../../src/core/db/schema";
import { DnsError } from "../../src/core/dns";
import { createLogger } from "../../src/core/log";
import { clearSsrfCache } from "../../src/core/ssrf";
import {
	handleDeliveryBatch,
	processDelivery,
	readSnippet,
} from "../../src/delivery/consumer";
import { signWebhook } from "../../src/delivery/sign";
import type { DeliveryMessage, Deps } from "../../src/deps";
import { testDeps, withFailingBatch } from "../helpers/deps";
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

function endlessBody(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		pull: (c) => c.enqueue(new Uint8Array(1024).fill(0x61)),
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

		expect(await processDelivery(deps, deliveryId, logger)).toBe("ack");

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
		expect(new Headers(init.headers).get("content-type")).toBe(
			"application/gzip",
		);
	});

	it.each([
		[
			"a 500",
			() => new Response("down", { status: 500 }),
			"http_5xx",
			500,
			"HTTP 500",
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

	it.each([
		[
			"timeout",
			new DOMException("The operation timed out.", "TimeoutError"),
			"timeout after 10000 ms",
		],
		[
			"network",
			new TypeError("Network connection lost."),
			"TypeError: Network connection lost.",
		],
	])("records a %s failure", async (errorKind, err, message) => {
		const deps = testDeps({
			fetch: vi.fn(async () => Promise.reject(err)) as unknown as typeof fetch,
		});
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p);
		expect(await processDelivery(deps, deliveryId, logger)).toBe("ack");
		const { delivery, attempts } = await state(deps, deliveryId);
		expect(delivery).toMatchObject({
			status: "failed_final",
			lastHttpStatus: null,
			lastError: message,
		});
		expect(attempts[0]).toMatchObject({
			errorKind,
			httpStatus: null,
			errorMessage: message,
			responseSnippet: null,
		});
	});

	it("fails a disabled destination without an attempt or a request", async () => {
		const fetchMock = fetchReturning(() => new Response("ok"));
		const deps = testDeps({ fetch: fetchMock });
		const p = await seedPipeline(deps, { destination: { status: "disabled" } });
		const { deliveryId } = await seedDelivery(deps, p);
		expect(await processDelivery(deps, deliveryId, logger)).toBe("ack");
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

	it("fails with dns_error when the resolver errors", async () => {
		const deps = testDeps({
			resolveDns: vi.fn(async () => Promise.reject(new DnsError("SERVFAIL"))),
		});
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p);
		await processDelivery(deps, deliveryId, logger);
		expect((await state(deps, deliveryId)).delivery).toMatchObject({
			status: "failed_final",
			lastError: "dns_error",
		});
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
		expect(results).toEqual(["ack", "ack"]);
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
		).toBe("ack");
	});

	it("retries when loading fails", async () => {
		const deps = testDeps();
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
		expect(
			await processDelivery(broken, "dlv_01JAAAAAAAAAAAAAAAAAAAAAAA", logger),
		).toBe("retry");
	});

	it("retries when recording fails and leaves the delivery in_flight (M2 lease fixes this)", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p);
		expect(
			await processDelivery(
				{ ...deps, db: withFailingBatch(deps.db) },
				deliveryId,
				logger,
			),
		).toBe("retry");
		expect((await state(deps, deliveryId)).delivery.status).toBe("in_flight");
	});

	it("keeps the HTTP status when the response body errors", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode("partial"));
				c.error(new Error("connection reset"));
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
});

describe("readSnippet", () => {
	it("caps the response snippet at 2 KB", async () => {
		const snippet = await readSnippet(new Response(endlessBody()));
		expect(snippet).toHaveLength(2048);
	});

	it("returns null for an empty body and decodes invalid UTF-8 lossily", async () => {
		expect(await readSnippet(new Response(null, { status: 204 }))).toBeNull();
		expect(await readSnippet(new Response(new Uint8Array([0x68, 0xff])))).toBe(
			"h�",
		);
	});
});

describe("handleDeliveryBatch", () => {
	it("acks or retries each message on its own", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p);
		const make = (id: string) => ({
			id,
			body: { deliveryId: id },
			timestamp: new Date(),
			attempts: 1,
			ack: vi.fn(),
			retry: vi.fn(),
		});
		const ok = make(deliveryId);
		const unknown = make("dlv_01JAAAAAAAAAAAAAAAAAAAAAAA");
		const batch = {
			queue: "hookflare-deliveries",
			messages: [ok, unknown],
			ackAll: vi.fn(),
			retryAll: vi.fn(),
		};
		await handleDeliveryBatch(
			batch as unknown as MessageBatch<DeliveryMessage>,
			deps,
		);
		expect(ok.ack).toHaveBeenCalledOnce();
		expect(unknown.ack).toHaveBeenCalledOnce();
		expect(ok.retry).not.toHaveBeenCalled();
	});
});
