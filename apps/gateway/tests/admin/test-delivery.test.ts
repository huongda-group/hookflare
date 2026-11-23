import type { Page, TestDelivery } from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/admin/auth/secrets";
import { deliveries, destinations } from "../../src/core/db/schema";
import { DnsError } from "../../src/core/dns";
import { clearRetryDefaultsCache } from "../../src/core/settings";
import { signWebhook } from "../../src/core/sign";
import { clearSsrfCache } from "../../src/core/ssrf";
import { adminApp, auditRows } from "../helpers/admin";
import { type RecordingQueue, recordingQueue, testDeps } from "../helpers/deps";
import { faultyDeps } from "../helpers/faults";
import { seedPipeline, TEST_SIGNING_SECRET } from "../helpers/seed";

describe("POST /destinations/:id/test", () => {
	beforeEach(() => {
		clearSsrfCache();
	});

	it("sends a signed default payload and records the result", async () => {
		// 204 must carry no body (workerd rejects a body on null-body statuses).
		const fetch = vi.fn(async () => new Response(null, { status: 204 }));
		const deps = testDeps({
			fetch: fetch as unknown as typeof globalThis.fetch,
			queue: recordingQueue(),
		});
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps, { role: "operator" });
		const res = await api.request(
			"POST",
			`/destinations/${destination.id}/test`,
		);
		expect(res.status).toBe(200);
		const body = await res.json<TestDelivery>();
		expect(body).toMatchObject({ http_status: 204, error_kind: null });
		expect(body.id).toMatch(/^tst_/);

		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(destination.url);
		expect(init.redirect).toBe("manual");
		const headers = new Headers(init.headers);
		expect(headers.get("webhook-id")).toBe(body.id);
		expect(headers.has("x-webhook-event-id")).toBe(false);
		expect(headers.get("x-hookflare-test")).toBe("1");
		const sent = init.body as Uint8Array;
		expect(JSON.parse(new TextDecoder().decode(sent))).toMatchObject({
			type: "hookflare.test",
			destination_id: destination.id,
		});
		expect(headers.get("webhook-signature")).toBe(
			await signWebhook({
				id: body.id,
				timestampSec: Number(headers.get("webhook-timestamp")),
				body: sent,
				secret: TEST_SIGNING_SECRET,
			}),
		);

		const [audit] = await auditRows(deps, destination.id);
		expect(audit).toMatchObject({
			action: "destination.tested",
			diffJson: {
				test_delivery_id: body.id,
				http_status: 204,
				error_kind: null,
				payload_sha256: await sha256Hex(new TextDecoder().decode(sent)),
			},
		});
		// Tests never touch the delivery pipeline.
		expect(
			await deps.db
				.select()
				.from(deliveries)
				.where(eq(deliveries.destinationId, destination.id)),
		).toEqual([]);
		expect((deps.queue as RecordingQueue).sent).toEqual([]);
	});

	it("forbids a custom payload without config.write and sends nothing", async () => {
		const fetch = vi.fn(async () => new Response(null, { status: 204 }));
		const deps = testDeps({
			fetch: fetch as unknown as typeof globalThis.fetch,
		});
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps, { role: "operator" });
		const res = await api.request(
			"POST",
			`/destinations/${destination.id}/test`,
			{ payload: { type: "invoice.paid", amount: 1 } },
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "forbidden",
			required: "config.write",
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(await auditRows(deps, destination.id)).toEqual([]);
		const tests = await api.request(
			"GET",
			`/destinations/${destination.id}/tests`,
		);
		expect(await tests.json()).toMatchObject({ data: [] });
	});

	it("sends a supplied payload and records an HTTP failure", async () => {
		const fetch = vi.fn(async () => new Response("nope", { status: 500 }));
		const deps = testDeps({
			fetch: fetch as unknown as typeof globalThis.fetch,
		});
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps, { role: "admin" });
		const body = await (
			await api.request("POST", `/destinations/${destination.id}/test`, {
				payload: { hello: "world" },
			})
		).json<TestDelivery>();
		expect(body).toMatchObject({
			http_status: 500,
			error_kind: "http_5xx",
			error_message: "HTTP 500",
			response_snippet: "nope",
		});
		const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(
			'{"hello":"world"}',
		);
		expect(new Headers(init.headers).get("x-hookflare-test")).toBe("1");
		const [audit] = await auditRows(deps, destination.id);
		// Only the hash of the payload is audited, never the payload itself.
		expect(audit.diffJson).toMatchObject({
			payload_sha256: await sha256Hex('{"hello":"world"}'),
		});
		expect(JSON.stringify(audit.diffJson)).not.toContain("world");
	});

	it("records ssrf_blocked without sending", async () => {
		const fetch = vi.fn();
		const deps = testDeps({
			fetch: fetch as unknown as typeof globalThis.fetch,
			resolveDns: vi.fn(async () => ["10.0.0.1"]),
		});
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps, { role: "operator" });
		const body = await (
			await api.request("POST", `/destinations/${destination.id}/test`)
		).json<TestDelivery>();
		expect(body).toMatchObject({
			http_status: null,
			error_kind: "ssrf_blocked",
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("answers 503 and records nothing when DNS fails", async () => {
		const deps = testDeps({
			resolveDns: vi.fn(async () => {
				throw new DnsError("resolver down");
			}),
		});
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps, { role: "operator" });
		expect(
			(await api.request("POST", `/destinations/${destination.id}/test`))
				.status,
		).toBe(503);
		expect(await auditRows(deps, destination.id)).toEqual([]);
	});

	it("records a network failure with no HTTP status", async () => {
		const fetch = vi.fn(async () => {
			throw new TypeError("connection reset");
		});
		const deps = testDeps({
			fetch: fetch as unknown as typeof globalThis.fetch,
		});
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps, { role: "operator" });
		const res = await api.request(
			"POST",
			`/destinations/${destination.id}/test`,
		);
		expect(res.status).toBe(200);
		const body = await res.json<TestDelivery>();
		expect(body.http_status).toBeNull();
		expect(body.error_kind).not.toBeNull();
		expect(body.response_snippet).toBeNull();
		const [audit] = await auditRows(deps, destination.id);
		expect(audit?.diffJson).toMatchObject({
			test_delivery_id: body.id,
			http_status: null,
			error_kind: body.error_kind,
		});
	});

	it("answers 500 and records nothing when the resolver fails unexpectedly", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetch = vi.fn();
		const deps = testDeps({
			fetch: fetch as unknown as typeof globalThis.fetch,
			resolveDns: vi.fn(async () => {
				throw new Error("resolver bug");
			}),
		});
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps, { role: "operator" });
		try {
			const res = await api.request(
				"POST",
				`/destinations/${destination.id}/test`,
			);
			expect(res.status).toBe(500);
			expect(await res.json()).toMatchObject({ error: "internal_error" });
			expect(fetch).not.toHaveBeenCalled();
			expect(await auditRows(deps, destination.id)).toEqual([]);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("rejects an invalid body or test-list query with 400", async () => {
		const fetch = vi.fn();
		const deps = testDeps({
			fetch: fetch as unknown as typeof globalThis.fetch,
		});
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps, { role: "operator" });
		const bad = await api.request(
			"POST",
			`/destinations/${destination.id}/test`,
			{ payload: {}, extra: 1 },
		);
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ error: "invalid_request" });
		expect(fetch).not.toHaveBeenCalled();
		for (const qs of ["limit=0", "cursor=@@"]) {
			const res = await api.request(
				"GET",
				`/destinations/${destination.id}/tests?${qs}`,
			);
			expect.soft(res.status, qs).toBe(400);
			expect.soft(await res.json()).toMatchObject({ error: "invalid_request" });
		}
	});

	it("answers 503 and records nothing when the retry defaults cannot load", async () => {
		const base = testDeps();
		const { destination } = await seedPipeline(base);
		const op = await adminApp(base, { role: "operator" });
		const api = await adminApp(
			faultyDeps(base, { d1: [{ match: /from "settings"/i }] }),
			{ username: op.username },
		);
		clearRetryDefaultsCache();
		expect(
			(await api.request("POST", `/destinations/${destination.id}/test`))
				.status,
		).toBe(503);
		expect(await auditRows(base, destination.id)).toEqual([]);
	});

	it("allows a paused destination and rejects a disabled one", async () => {
		const deps = testDeps();
		const { destination } = await seedPipeline(deps, {
			destination: { status: "paused" },
		});
		const api = await adminApp(deps, { role: "operator" });
		expect(
			(await api.request("POST", `/destinations/${destination.id}/test`))
				.status,
		).toBe(200);
		await deps.db
			.update(destinations)
			.set({ status: "disabled" })
			.where(eq(destinations.id, destination.id));
		const res = await api.request(
			"POST",
			`/destinations/${destination.id}/test`,
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "destination_disabled" });
	});

	it("is forbidden to a viewer, who can still list tests", async () => {
		const deps = testDeps();
		const { destination } = await seedPipeline(deps);
		const op = await adminApp(deps, { role: "operator" });
		for (let i = 0; i < 3; i++) {
			await op.request("POST", `/destinations/${destination.id}/test`);
		}
		const viewer = await adminApp(deps, { role: "viewer" });
		expect(
			(await viewer.request("POST", `/destinations/${destination.id}/test`))
				.status,
		).toBe(403);
		const first = await (
			await viewer.request(
				"GET",
				`/destinations/${destination.id}/tests?limit=2`,
			)
		).json<Page<TestDelivery>>();
		expect(first.data).toHaveLength(2);
		expect(first.next_cursor).not.toBeNull();
		const second = await (
			await viewer.request(
				"GET",
				`/destinations/${destination.id}/tests?limit=2&cursor=${first.next_cursor}`,
			)
		).json<Page<TestDelivery>>();
		expect(second.data).toHaveLength(1);
		expect(second.next_cursor).toBeNull();
		const ids = [...first.data, ...second.data].map((t) => t.id);
		expect(ids).toEqual([...ids].sort().reverse());
	});
});
