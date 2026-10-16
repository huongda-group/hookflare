import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessKeyCache } from "../src/admin/auth/access";
import { createApp } from "../src/app";
import { acquireLease } from "../src/core/db/deliveries";
import { deliveries } from "../src/core/db/schema";
import { createLogger } from "../src/core/log";
import { signWebhook } from "../src/core/sign";
import { clearSourceCache } from "../src/core/source-cache";
import { clearSsrfCache } from "../src/core/ssrf";
import { processDelivery } from "../src/delivery/consumer";
import type { Deps } from "../src/deps";
import { reconcile } from "../src/jobs/reconcile";
import { adminApp } from "./helpers/admin";
import { recordingQueue, testDeps } from "./helpers/deps";

const HOST = "https://hookflare.example.com";

async function hmacHex(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
	);
	return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Create project → destination → hmac source through the admin API. */
async function setup(deps: Deps) {
	const api = await adminApp(deps);
	const project = await (
		await api.request("POST", "/projects", {
			name: "E2E",
			slug: `e2e-${crypto.randomUUID().slice(0, 8)}`,
		})
	).json<{ id: string }>();
	const destination = await (
		await api.request("POST", "/destinations", {
			project_id: project.id,
			name: "Backend",
			url: "https://backend.example.com/hooks",
		})
	).json<{ id: string; signing_secret: string }>();
	const source = await (
		await api.request("POST", "/sources", {
			project_id: project.id,
			destination_id: destination.id,
			name: "Provider",
			auth_type: "hmac",
			auth_config: {
				header: "x-signature",
				algorithm: "sha256",
				encoding: "hex",
				prefix: "sha256=",
			},
			event_id_from: "json_path",
			event_id_selector: "$.id",
		})
	).json<{ id: string; secret: string; ingress_url: string }>();
	return { api, project, destination, source };
}

async function send(
	deps: Deps,
	ingressUrl: string,
	secret: string,
	body: string,
) {
	return createApp({ createDeps: () => deps }).request(
		ingressUrl,
		{
			method: "POST",
			body,
			headers: {
				"content-type": "application/json",
				"x-signature": `sha256=${await hmacHex(secret, body)}`,
			},
		},
		deps.env,
	);
}

describe("end to end", () => {
	beforeEach(() => {
		clearAccessKeyCache();
		clearSourceCache();
		clearSsrfCache();
		for (const m of ["log", "warn", "error"] as const)
			vi.spyOn(console, m).mockImplementation(() => {});
	});

	it("delivers a signed webhook created entirely through the API", async () => {
		const queue = recordingQueue();
		const deps = testDeps({ queue });
		const { api, destination, source } = await setup(deps);
		expect(source.ingress_url).toBe(`${HOST}/in/${source.id}`);

		const body = JSON.stringify({ id: "evt_provider_42", type: "order.paid" });
		const accepted = await send(deps, source.ingress_url, source.secret, body);
		expect(accepted.status).toBe(202);
		const { event_id } = await accepted.json<{ event_id: string }>();
		expect(queue.sent).toHaveLength(1);

		expect(
			await processDelivery(
				deps,
				queue.sent[0].deliveryId,
				createLogger(deps.env, {}),
			),
		).toEqual({ action: "ack" });

		const fetchMock = vi.mocked(deps.fetch);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://backend.example.com/hooks");
		const headers = new Headers(init.headers);
		expect(headers.get("x-webhook-event-id")).toBe(event_id);
		expect(headers.get("x-signature")).toBeNull();
		const expected = await signWebhook({
			id: headers.get("webhook-id") as string,
			timestampSec: Number(headers.get("webhook-timestamp")),
			body: new TextEncoder().encode(body),
			secret: destination.signing_secret,
		});
		expect(headers.get("webhook-signature")).toBe(expected);

		const event = await (await api.request("GET", `/events/${event_id}`)).json<{
			provider_event_id: string;
			deliveries: {
				status: string;
				attempts: { http_status: number; duration_ms: number }[];
			}[];
		}>();
		expect(event.provider_event_id).toBe("evt_provider_42");
		expect(event.deliveries).toHaveLength(1);
		expect(event.deliveries[0].status).toBe("delivered");
		expect(event.deliveries[0].attempts).toHaveLength(1);
		expect(event.deliveries[0].attempts[0].http_status).toBe(200);
		expect(event.deliveries[0].attempts[0].duration_ms).toBeGreaterThanOrEqual(
			0,
		);
	});

	it("accepts and stores webhooks while the backend is offline, scheduled for retry", async () => {
		const queue = recordingQueue();
		const deps = testDeps({
			queue,
			fetch: vi.fn(async () => {
				throw new TypeError("Network connection lost.");
			}) as unknown as typeof fetch,
		});
		const { api, source } = await setup(deps);

		const accepted = await send(
			deps,
			source.ingress_url,
			source.secret,
			JSON.stringify({ id: "evt_offline" }),
		);
		expect(accepted.status).toBe(202);
		const { event_id } = await accepted.json<{ event_id: string }>();
		await processDelivery(
			deps,
			queue.sent[0].deliveryId,
			createLogger(deps.env, {}),
		);

		const event = await (await api.request("GET", `/events/${event_id}`)).json<{
			deliveries: {
				status: string;
				last_error: string | null;
				attempts: { error_kind: string; http_status: number | null }[];
			}[];
		}>();
		expect(event.deliveries[0].status).toBe("retrying");
		expect(event.deliveries[0].last_error).toContain("Network connection lost");
		expect(event.deliveries[0].attempts).toEqual([
			expect.objectContaining({ error_kind: "network", http_status: null }),
		]);
	});

	it("rejects a webhook with a bad signature and stores nothing", async () => {
		const queue = recordingQueue();
		const deps = testDeps({ queue });
		const { source } = await setup(deps);
		const res = await send(
			deps,
			source.ingress_url,
			"wrong-secret-0123456789",
			JSON.stringify({ id: "x" }),
		);
		expect(res.status).toBe(401);
		expect(queue.sent).toHaveLength(0);
	});
});

describe("reliability (M2 exit criteria)", () => {
	const T0 = 1_800_000_000_000;
	beforeEach(() => {
		clearAccessKeyCache();
		clearSourceCache();
		clearSsrfCache();
		for (const m of ["log", "warn", "error"] as const)
			vi.spyOn(console, m).mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	function clockedDeps(fetchImpl: (n: number) => Response | Promise<Response>) {
		let t = T0;
		let calls = 0;
		const queue = recordingQueue();
		const deps = testDeps({
			queue,
			now: () => t,
			fetch: vi.fn(async () => fetchImpl(++calls)) as unknown as typeof fetch,
		});
		return { deps, queue, set: (v: number) => (t = v), calls: () => calls };
	}

	async function delivery(deps: Deps, id: string) {
		const [d] = await deps.db
			.select()
			.from(deliveries)
			.where(eq(deliveries.id, id));
		return d;
	}

	it("fails twice, then delivers; the timeline shows all three attempts", async () => {
		const { deps, queue, set } = clockedDeps((n) =>
			n < 3 ? new Response("", { status: 503 }) : new Response("ok"),
		);
		const { api, source } = await setup(deps);
		const res = await send(
			deps,
			source.ingress_url,
			source.secret,
			JSON.stringify({ id: "r1" }),
		);
		const { event_id } = await res.json<{ event_id: string }>();
		const id = queue.sent[0].deliveryId;
		const logger = createLogger(deps.env, {});
		for (let i = 0; i < 3; i++) {
			await processDelivery(deps, id, logger);
			const d = await delivery(deps, id);
			if (d.nextAttemptAt) set(d.nextAttemptAt);
		}
		const event = await (await api.request("GET", `/events/${event_id}`)).json<{
			deliveries: { status: string; attempts: { http_status: number }[] }[];
		}>();
		expect(event.deliveries[0].status).toBe("delivered");
		expect(event.deliveries[0].attempts.map((a) => a.http_status)).toEqual([
			503, 503, 200,
		]);
		expect(queue.sent).toHaveLength(3); // ingress + 2 reschedules
	});

	it("still delivers to a backend that recovers after 48 h", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0); // shortest delays: worst case for the window
		let now = T0;
		const { deps, queue, set } = clockedDeps(() =>
			now < T0 + 48 * 3_600_000
				? new Response("", { status: 503 })
				: new Response("ok"),
		);
		const { source } = await setup(deps);
		await send(
			deps,
			source.ingress_url,
			source.secret,
			JSON.stringify({ id: "r48" }),
		);
		const id = queue.sent[0].deliveryId;
		const logger = createLogger(deps.env, {});
		for (let i = 0; i < 25; i++) {
			await processDelivery(deps, id, logger);
			const d = await delivery(deps, id);
			if (d.status !== "retrying") break;
			now = d.nextAttemptAt as number;
			set(now);
		}
		const d = await delivery(deps, id);
		expect(d.status).toBe("delivered");
		expect(d.attemptCount).toBeLessThanOrEqual(20);
		expect(now - T0).toBeGreaterThanOrEqual(48 * 3_600_000);
	});

	it("recovers a delivery whose worker crashed holding the lease", async () => {
		const { deps, queue, set } = clockedDeps(() => new Response("ok"));
		const { source } = await setup(deps);
		await send(
			deps,
			source.ingress_url,
			source.secret,
			JSON.stringify({ id: "crash" }),
		);
		const id = queue.sent[0].deliveryId;
		// The worker leased, then died before sending or recording.
		await acquireLease(deps, id, T0 + 40_000);
		set(T0 + 40_000 + 6 * 60_000);
		await reconcile(deps);
		expect(await delivery(deps, id)).toMatchObject({
			status: "retrying",
			attemptCount: 0,
		});
		expect(queue.sent).toContainEqual({ deliveryId: id });
		await processDelivery(deps, id, createLogger(deps.env, {}));
		expect(await delivery(deps, id)).toMatchObject({
			status: "delivered",
			attemptCount: 1,
		});
	});

	it("forwards a 200 KB body from R2 byte-for-byte with a valid signature", async () => {
		const received: { body: Uint8Array; headers: Headers }[] = [];
		const queue = recordingQueue();
		const deps = testDeps({
			queue,
			fetch: vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
				received.push({
					body: new Uint8Array(init?.body as ArrayBuffer),
					headers: new Headers(init?.headers),
				});
				return new Response("ok");
			}) as unknown as typeof fetch,
		});
		const { source, destination } = await setup(deps);
		const signingSecret = destination.signing_secret;
		const payload = JSON.stringify({ id: "big", pad: "x".repeat(200_000) });
		expect(
			(await send(deps, source.ingress_url, source.secret, payload)).status,
		).toBe(202);
		await processDelivery(
			deps,
			queue.sent[0].deliveryId,
			createLogger(deps.env, {}),
		);
		expect(new TextDecoder().decode(received[0].body)).toBe(payload);
		const h = received[0].headers;
		const expected = await signWebhook({
			id: h.get("webhook-id") as string,
			timestampSec: Number(h.get("webhook-timestamp")),
			body: received[0].body as Uint8Array<ArrayBuffer>,
			secret: signingSecret,
		});
		expect(h.get("webhook-signature")).toBe(expected);
	});
});
