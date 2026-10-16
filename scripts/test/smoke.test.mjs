import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	httpSmokeApi,
	pollUntil,
	runSmoke,
	signStandardWebhook,
	smokeEnv,
} from "../lib/smoke.mjs";

/**
 * Build a fake SmokeApi whose deliveries turn delivered on the third poll
 * and whose replay delivery is delivered immediately. The sink reports one
 * unique delivery received twice (initial + replay).
 * @returns {{ api: object, calls: { deliveries: number, sleep: number } }}
 */
function happyApi() {
	const calls = { deliveries: 0, sleep: 0 };
	let replayed = null;
	const api = {
		sinkUrl: "https://sink.example.com",
		async ensureProject() {
			return { id: "prj_smoke" };
		},
		async ensureDestination() {
			return { id: "dst_smoke" };
		},
		async ensureSource() {
			return {
				id: "src_smoke",
				ingress_url: "https://hooks.example.com/in/src_smoke",
			};
		},
		async send() {
			return "evt_smoke";
		},
		async deliveries() {
			calls.deliveries++;
			const initial =
				calls.deliveries >= 3
					? { id: "dlv_initial", status: "delivered" }
					: { id: "dlv_initial", status: "retrying" };
			const all = [initial];
			if (replayed !== null) {
				all.push({ id: replayed, status: "delivered" });
			}
			return all;
		},
		async replay() {
			replayed = "dlv_replay";
			return { delivery_id: replayed };
		},
		async sinkStats() {
			return { unique: 1, received: 2 };
		},
	};
	return { api, calls };
}

describe("runSmoke", () => {
	it("polls until delivered, replays, and checks the sink", async () => {
		const { api, calls } = happyApi();
		const result = await runSmoke(api, () => {}, {
			sleep: async () => {
				calls.sleep++;
			},
		});
		assert.equal(result.eventId, "evt_smoke");
		assert.deepEqual(result.deliveryIds, ["dlv_initial", "dlv_replay"]);
		assert.equal(typeof result.sinkRun, "string");
		assert.ok(result.sinkRun.length > 0);
		assert.ok(calls.deliveries >= 3, `only ${calls.deliveries} delivery polls`);
	});

	it("throws when the replay delivery never leaves retrying", async () => {
		const { api } = happyApi();
		api.replay = async () => ({ delivery_id: "dlv_stuck" });
		await assert.rejects(
			runSmoke(api, () => {}, { sleep: async () => {} }),
			/smoke: replay not delivered within 60s/,
		);
	});

	it("throws when the sink received count is not 2", async () => {
		const { api } = happyApi();
		api.sinkStats = async () => ({ unique: 1, received: 1 });
		await assert.rejects(
			runSmoke(api, () => {}, { sleep: async () => {} }),
			/smoke: /,
		);
	});

	it("throws when the sink unique count is not 1", async () => {
		const { api } = happyApi();
		api.sinkStats = async () => ({ unique: 2, received: 2 });
		await assert.rejects(
			runSmoke(api, () => {}, { sleep: async () => {} }),
			/smoke: expected sink unique=1 received=2, got unique=2 received=2/,
		);
	});
});

describe("httpSmokeApi", () => {
	it("creates an hmac source and signs ingress with the run secret", async () => {
		const { createHmac } = await import("node:crypto");
		const seen = {};
		const fetchFn = async (url, init = {}) => {
			if (url.endsWith("/api/admin/v1/projects?limit=200")) {
				return new Response(
					JSON.stringify({
						data: [{ id: "prj_smoke", slug: "smoke", name: "smoke" }],
					}),
					{ status: 200 },
				);
			}
			if (url.endsWith("/api/admin/v1/destinations")) {
				return new Response(JSON.stringify({ id: "dst_smoke" }), {
					status: 201,
				});
			}
			if (url.endsWith("/api/admin/v1/sources")) {
				seen.sourceBody = JSON.parse(init.body);
				return new Response(
					JSON.stringify({
						id: "src_smoke",
						ingress_url: "https://hooks.example.com/in/src_smoke",
					}),
					{ status: 201 },
				);
			}
			if (url === "https://hooks.example.com/in/src_smoke") {
				seen.ingressHeaders = init.headers;
				seen.ingressBody = init.body;
				return new Response(JSON.stringify({ event_id: "evt_smoke" }), {
					status: 202,
				});
			}
			throw new Error(`unexpected fetch ${url}`);
		};
		const api = httpSmokeApi(
			{
				url: "https://api.example.com",
				clientId: "id",
				clientSecret: "secret",
				sinkUrl: "https://sink.example.com",
			},
			fetchFn,
		);
		await api.ensureProject("smoke");
		await api.ensureDestination("https://sink.example.com/r/run/hook");
		const source = await api.ensureSource();
		assert.equal(source.id, "src_smoke");
		assert.equal(seen.sourceBody.auth_type, "hmac");
		assert.deepEqual(seen.sourceBody.auth_config, {
			header: "x-smoke-signature",
			algorithm: "sha256",
			encoding: "hex",
		});
		assert.equal(typeof seen.sourceBody.secret, "string");
		assert.ok(seen.sourceBody.secret.length >= 16);
		const eventId = await api.send();
		assert.equal(eventId, "evt_smoke");
		// The ingress signature must verify as HMAC-SHA256(secret, body).
		const expected = createHmac("sha256", seen.sourceBody.secret)
			.update(seen.ingressBody)
			.digest("hex");
		assert.equal(seen.ingressHeaders["x-smoke-signature"], expected);
	});
});

describe("pollUntil", () => {
	it("returns the first non-null value", async () => {
		let n = 0;
		const value = await pollUntil(
			async () => {
				n++;
				return n >= 3 ? "done" : null;
			},
			{ timeoutMs: 60000, intervalMs: 1000, sleep: async () => {} },
		);
		assert.equal(value, "done");
		assert.equal(n, 3);
	});
});

describe("smokeEnv", () => {
	it("returns null when any variable is missing", () => {
		assert.equal(smokeEnv({}), null);
		assert.equal(
			smokeEnv({
				HOOKFLARE_URL: "https://hooks.example.com",
				CF_ACCESS_CLIENT_ID: "id",
				CF_ACCESS_CLIENT_SECRET: "secret",
			}),
			null,
		);
	});

	it("returns the env when every variable is set", () => {
		assert.deepEqual(
			smokeEnv({
				HOOKFLARE_URL: "https://hooks.example.com",
				CF_ACCESS_CLIENT_ID: "id",
				CF_ACCESS_CLIENT_SECRET: "secret",
				SINK_URL: "https://sink.example.com",
			}),
			{
				url: "https://hooks.example.com",
				clientId: "id",
				clientSecret: "secret",
				sinkUrl: "https://sink.example.com",
			},
		);
	});
});

describe("signStandardWebhook", () => {
	it("matches HMAC-SHA256 over id.timestamp.body in the v1 format", async () => {
		const { createHmac } = await import("node:crypto");
		const secret = `whsec_${Buffer.from("test-secret-key-0123456789abcdef").toString("base64")}`;
		const id = "msg_smoke";
		const ts = 1729094400;
		const body = new TextEncoder().encode('{"smoke":true}');
		const raw = Buffer.from(atob(secret.slice("whsec_".length)), "binary");
		const expected = `v1,${createHmac("sha256", raw).update(`${id}.${ts}.`).update(body).digest("base64")}`;
		assert.equal(await signStandardWebhook(secret, id, ts, body), expected);
	});
});
