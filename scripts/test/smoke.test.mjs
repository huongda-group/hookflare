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
 * and whose replay delivery is delivered immediately. The sink reports the
 * initial delivery and the replay: two receives under two webhook IDs
 * (the gateway's webhook-id is the delivery ID, and a replay is a new
 * delivery of the same event).
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
			return { unique: 2, received: 2, ids: ["dlv_initial", "dlv_replay"] };
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
		api.sinkStats = async () => ({
			unique: 2,
			received: 3,
			ids: ["dlv_initial", "dlv_replay"],
		});
		await assert.rejects(
			runSmoke(api, () => {}, { sleep: async () => {} }),
			/smoke: expected sink received=2 with webhook IDs dlv_initial,dlv_replay, got received=3/,
		);
	});

	it("throws when the sink saw other webhook IDs than the two deliveries", async () => {
		const { api } = happyApi();
		api.sinkStats = async () => ({
			unique: 1,
			received: 2,
			ids: ["dlv_initial"],
		});
		await assert.rejects(
			runSmoke(api, () => {}, { sleep: async () => {} }),
			/smoke: expected sink received=2 with webhook IDs dlv_initial,dlv_replay, got received=2 ids=dlv_initial/,
		);
	});
});

const smokeTestEnv = {
	url: "https://api.example.com",
	clientId: "id",
	clientSecret: "secret",
	sinkUrl: "https://sink.example.com",
};

/**
 * In-memory admin API for httpSmokeApi: pages lists at the requested
 * limit (rejecting limit > 100 like the shared pageLimit), and records
 * every mutating call.
 * @param {{ projects?: object[], destinations?: object[], sources?: object[] }} [seed]
 */
function fakeAdmin(seed = {}) {
	const store = {
		projects: seed.projects ?? [],
		destinations: seed.destinations ?? [],
		sources: seed.sources ?? [],
	};
	/** @type {{ method: string, path: string, body: any }[]} */
	const mutations = [];
	const ingress = {};
	let n = 0;
	const json = (body, status = 200) =>
		new Response(JSON.stringify(body), { status });
	const fetchFn = async (rawUrl, init = {}) => {
		const method = init.method ?? "GET";
		const url = new URL(rawUrl);
		const body = init.body === undefined ? undefined : JSON.parse(init.body);
		if (url.origin === "https://hooks.example.com") {
			ingress.headers = init.headers;
			ingress.body = init.body;
			return json({ event_id: "evt_smoke" }, 202);
		}
		if (url.origin === "https://sink.example.com") {
			ingress.sinkQuery = url.search;
			return json({ received: 2, unique: 2, ids: ["a", "b"] });
		}
		const path = url.pathname.replace("/api/admin/v1", "");
		const [, kind, id, action] = path.split("/");
		if (method === "GET") {
			const limit = Number(url.searchParams.get("limit") ?? "50");
			if (limit > 100) {
				return json({ error: "invalid_request" }, 400);
			}
			const projectId = url.searchParams.get("project_id");
			const all = store[kind].filter(
				(row) => projectId === null || row.project_id === projectId,
			);
			const start = Number(url.searchParams.get("cursor") ?? "0");
			const data = all.slice(start, start + limit);
			const next = start + limit < all.length ? String(start + limit) : null;
			return json({ data, next_cursor: next });
		}
		mutations.push({ method, path, body });
		if (method === "POST" && id === undefined) {
			const row = {
				...body,
				id: `${kind}_${++n}`,
				ingress_url: `https://hooks.example.com/in/${kind}_${n}`,
			};
			delete row.secret;
			store[kind].push(row);
			return json(row, 201);
		}
		const row = store[kind].find((r) => r.id === id);
		if (method === "PATCH") {
			Object.assign(row, body);
			return json(row);
		}
		if (method === "POST" && action === "rotate-secret") {
			return json(row);
		}
		throw new Error(`unexpected ${method} ${path}`);
	};
	return { store, mutations, ingress, fetchFn };
}

const hmacConfig = {
	header: "x-smoke-signature",
	algorithm: "sha256",
	encoding: "hex",
};

describe("httpSmokeApi", () => {
	it("creates an hmac source and signs ingress with the run secret", async () => {
		const { createHmac } = await import("node:crypto");
		const admin = fakeAdmin();
		const api = httpSmokeApi(smokeTestEnv, admin.fetchFn);
		await api.ensureProject("smoke");
		await api.ensureDestination("https://sink.example.com/r/run/hook");
		const source = await api.ensureSource();
		const created = admin.mutations.find((m) => m.path === "/sources");
		assert.equal(source.id, admin.store.sources[0].id);
		assert.equal(created.body.auth_type, "hmac");
		assert.deepEqual(created.body.auth_config, hmacConfig);
		assert.equal(typeof created.body.secret, "string");
		assert.ok(created.body.secret.length >= 16);
		const eventId = await api.send();
		assert.equal(eventId, "evt_smoke");
		// The ingress signature must verify as HMAC-SHA256(secret, body).
		const expected = createHmac("sha256", created.body.secret)
			.update(admin.ingress.body)
			.digest("hex");
		assert.equal(admin.ingress.headers["x-smoke-signature"], expected);
	});

	it("finds the smoke project on a later page with limit <= 100", async () => {
		const projects = Array.from({ length: 150 }, (_, i) => ({
			id: `prj_${i}`,
			slug: `p-${i}`,
			name: `p-${i}`,
		}));
		projects.push({ id: "prj_smoke", slug: "smoke", name: "smoke" });
		const admin = fakeAdmin({ projects });
		const api = httpSmokeApi(smokeTestEnv, admin.fetchFn);
		assert.deepEqual(await api.ensureProject("smoke"), { id: "prj_smoke" });
		assert.deepEqual(admin.mutations, []);
	});

	it("reuses the smoke destination and source, updating what changed", async () => {
		const { createHmac } = await import("node:crypto");
		const admin = fakeAdmin({
			projects: [{ id: "prj_smoke", slug: "smoke", name: "smoke" }],
			destinations: [
				{
					id: "dst_old",
					project_id: "prj_smoke",
					name: "smoke",
					url: "https://sink.example.com/r/old/hook",
				},
			],
			sources: [
				{
					id: "src_old",
					project_id: "prj_smoke",
					destination_id: "dst_old",
					name: "smoke",
					auth_type: "hmac",
					auth_config: hmacConfig,
					ingress_url: "https://hooks.example.com/in/src_old",
				},
			],
		});
		const api = httpSmokeApi(smokeTestEnv, admin.fetchFn);
		await api.ensureProject("smoke");
		const destination = await api.ensureDestination(
			"https://sink.example.com/r/new/hook",
		);
		assert.equal(destination.id, "dst_old");
		const source = await api.ensureSource();
		assert.deepEqual(source, {
			id: "src_old",
			ingress_url: "https://hooks.example.com/in/src_old",
		});
		assert.deepEqual(
			admin.mutations.map((m) => `${m.method} ${m.path}`),
			["PATCH /destinations/dst_old", "POST /sources/src_old/rotate-secret"],
		);
		assert.equal(
			admin.mutations[0].body.url,
			"https://sink.example.com/r/new/hook",
		);
		const rotated = admin.mutations[1].body;
		assert.equal(rotated.grace_hours, 0);
		assert.ok(rotated.secret.length >= 16);
		await api.send();
		const expected = createHmac("sha256", rotated.secret)
			.update(admin.ingress.body)
			.digest("hex");
		assert.equal(admin.ingress.headers["x-smoke-signature"], expected);
	});

	it("rejects a reused smoke source that is not hmac", async () => {
		const admin = fakeAdmin({
			projects: [{ id: "prj_smoke", slug: "smoke", name: "smoke" }],
			destinations: [
				{
					id: "dst_old",
					project_id: "prj_smoke",
					name: "smoke",
					url: "https://sink.example.com/r/run/hook",
				},
			],
			sources: [
				{
					id: "src_old",
					project_id: "prj_smoke",
					destination_id: "dst_old",
					name: "smoke",
					auth_type: "none",
					auth_config: {},
				},
			],
		});
		const api = httpSmokeApi(smokeTestEnv, admin.fetchFn);
		await api.ensureProject("smoke");
		await api.ensureDestination("https://sink.example.com/r/run/hook");
		await assert.rejects(api.ensureSource(), /smoke: source src_old/);
		assert.deepEqual(admin.mutations, []);
	});

	it("asks the sink for the run's webhook IDs", async () => {
		const admin = fakeAdmin();
		const api = httpSmokeApi(smokeTestEnv, admin.fetchFn);
		assert.deepEqual(await api.sinkStats("run1"), {
			received: 2,
			unique: 2,
			ids: ["a", "b"],
		});
		assert.equal(admin.ingress.sinkQuery, "?ids=1");
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
