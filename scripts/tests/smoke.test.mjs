import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	checkSmokeTarget,
	httpSmokeApi,
	pollUntil,
	runId,
	runSmoke,
	signStandardWebhook,
	smokeEnv,
	smokeUrlVar,
} from "../lib/smoke.mjs";

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
	token: "hf_test_token",
	sinkUrl: "https://sink.example.com",
};

function fakeAdmin(seed = {}) {
	const store = {
		projects: seed.projects ?? [],
		destinations: seed.destinations ?? [],
		sources: seed.sources ?? [],
	};
	const mutations = [];
	const ingress = {};
	const headers = [];
	let n = 0;
	const json = (body, status = 200) =>
		new Response(JSON.stringify(body), { status });
	const fetchFn = async (rawUrl, init = {}) => {
		const method = init.method ?? "GET";
		const url = new URL(rawUrl);
		const body = init.body === undefined ? undefined : JSON.parse(init.body);
		if (url.origin === "https://api.example.com") {
			headers.push({ ...init.headers });
		}
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
			if (id !== undefined) {
				const row = store[kind].find((item) => item.id === id);
				return row ? json(row) : json({ error: "not_found" }, 404);
			}
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
	return { store, mutations, ingress, headers, fetchFn };
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
		const project = await api.ensureProject("smoke");
		await api.ensureDestination("https://sink.example.com/r/run/hook");
		const source = await api.ensureSource();
		const created = admin.mutations.find((m) => m.path === "/sources");
		assert.deepEqual(admin.mutations[0].body, { name: "smoke" });
		assert.equal(admin.mutations[1].body.project_id, project.id);
		assert.equal(created.body.project_id, project.id);
		assert.equal(source.id, admin.store.sources[0].id);
		assert.equal(created.body.auth_type, "hmac");
		assert.deepEqual(created.body.auth_config, hmacConfig);
		assert.equal(typeof created.body.secret, "string");
		assert.ok(created.body.secret.length >= 16);
		const eventId = await api.send();
		assert.equal(eventId, "evt_smoke");
		const expected = createHmac("sha256", created.body.secret)
			.update(admin.ingress.body)
			.digest("hex");
		assert.equal(admin.ingress.headers["x-smoke-signature"], expected);
	});

	it("finds the smoke project on a later page with limit <= 100", async () => {
		const projects = Array.from({ length: 150 }, (_, i) => ({
			id: `prj_${i}`,
			name: `p-${i}`,
		}));
		projects.push({ id: "prj_smoke", name: "smoke" });
		const admin = fakeAdmin({ projects });
		const api = httpSmokeApi(smokeTestEnv, admin.fetchFn);
		assert.deepEqual(await api.ensureProject("smoke"), { id: "prj_smoke" });
		assert.deepEqual(admin.mutations, []);
	});

	it("rejects ambiguous smoke project names across pages before mutations", async () => {
		const admin = fakeAdmin({
			projects: [
				{ id: "prj_first", name: "smoke" },
				...Array.from({ length: 100 }, (_, i) => ({
					id: `prj_${i}`,
					name: `p-${i}`,
				})),
				{ id: "prj_second", name: "smoke" },
			],
		});
		const api = httpSmokeApi(smokeTestEnv, admin.fetchFn);
		await assert.rejects(api.ensureProject("smoke"), /multiple projects/);
		assert.deepEqual(admin.mutations, []);
	});

	it("uses the configured project ID even if the smoke project was renamed", async () => {
		const admin = fakeAdmin({
			projects: [
				{ id: "prj_other", name: "smoke" },
				{ id: "prj_pinned", name: "Renamed smoke" },
			],
		});
		const env = smokeEnv(
			{
				HOOKFLARE_STAGING_URL: smokeTestEnv.url,
				HOOKFLARE_API_TOKEN: smokeTestEnv.token,
				SINK_URL: smokeTestEnv.sinkUrl,
				HOOKFLARE_STAGING_SMOKE_PROJECT_ID: "prj_pinned",
				HOOKFLARE_SMOKE_PROJECT_ID: "prj_other",
			},
			{ urlVar: "HOOKFLARE_STAGING_URL" },
		);
		const api = httpSmokeApi(env, admin.fetchFn);
		assert.deepEqual(await api.ensureProject("smoke"), { id: "prj_pinned" });
		assert.deepEqual(admin.mutations, []);
	});

	it("does not fall back to a name when the configured project ID is missing", async () => {
		const admin = fakeAdmin({ projects: [{ id: "prj_other", name: "smoke" }] });
		const api = httpSmokeApi(
			{ ...smokeTestEnv, projectId: "prj_missing" },
			admin.fetchFn,
		);
		await assert.rejects(api.ensureProject("smoke"), /get project prj_missing/);
		assert.deepEqual(admin.mutations, []);
	});

	it("reuses the smoke destination and source, updating what changed", async () => {
		const { createHmac } = await import("node:crypto");
		const admin = fakeAdmin({
			projects: [{ id: "prj_smoke", name: "smoke" }],
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
			projects: [{ id: "prj_smoke", name: "smoke" }],
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

	it("sends the API token as a Bearer authorization header", async () => {
		const admin = fakeAdmin();
		const api = httpSmokeApi(smokeTestEnv, admin.fetchFn);
		await api.ensureProject("smoke");
		await api.ensureDestination("https://sink.example.com/r/run/hook");
		assert.ok(admin.headers.length > 0);
		for (const seen of admin.headers) {
			assert.equal(seen.authorization, "Bearer hf_test_token");
			assert.ok(!("CF-Access-Client-Id" in seen));
			assert.ok(!("CF-Access-Client-Secret" in seen));
		}
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
				HOOKFLARE_API_TOKEN: "hf_test_token",
			}),
			null,
		);
	});

	it("returns null when HOOKFLARE_API_TOKEN is missing", () => {
		assert.equal(
			smokeEnv({
				HOOKFLARE_URL: "https://hooks.example.com",
				SINK_URL: "https://sink.example.com",
			}),
			null,
		);
	});

	it("returns the env when every variable is set", () => {
		assert.deepEqual(
			smokeEnv({
				HOOKFLARE_URL: "https://hooks.example.com",
				HOOKFLARE_API_TOKEN: "hf_test_token",
				SINK_URL: "https://sink.example.com",
			}),
			{
				url: "https://hooks.example.com",
				token: "hf_test_token",
				sinkUrl: "https://sink.example.com",
			},
		);
	});

	it("reads the URL from the given variable", () => {
		const env = {
			HOOKFLARE_URL: "https://prod.example.com",
			HOOKFLARE_STAGING_URL: "https://staging.example.com",
			HOOKFLARE_API_TOKEN: "hf_test_token",
			SINK_URL: "https://sink.example.com",
		};
		assert.equal(
			smokeEnv(env, { urlVar: "HOOKFLARE_STAGING_URL" })?.url,
			"https://staging.example.com",
		);
		const { HOOKFLARE_STAGING_URL: _, ...prodOnly } = env;
		assert.equal(smokeEnv(prodOnly, { urlVar: "HOOKFLARE_STAGING_URL" }), null);
	});
});

describe("smokeUrlVar", () => {
	it("derives the URL variable from the worker name", () => {
		assert.equal(smokeUrlVar("hookflare"), "HOOKFLARE_URL");
		assert.equal(smokeUrlVar("hookflare-staging"), "HOOKFLARE_STAGING_URL");
	});
});

describe("checkSmokeTarget", () => {
	it("accepts the worker's own workers.dev host", () => {
		checkSmokeTarget("https://hookflare-staging.acme.workers.dev", {
			worker: "hookflare-staging",
			publicBaseUrl: "",
		});
	});

	it("rejects another worker's workers.dev host", () => {
		assert.throws(
			() =>
				checkSmokeTarget("https://hookflare.acme.workers.dev", {
					worker: "hookflare-staging",
					publicBaseUrl: "",
				}),
			/smoke: .*hookflare\.acme\.workers\.dev.* is not worker hookflare-staging/,
		);
	});

	it("requires the PUBLIC_BASE_URL origin when the config sets one", () => {
		checkSmokeTarget("https://hooks.example.com/", {
			worker: "hookflare",
			publicBaseUrl: "https://hooks.example.com",
		});
		assert.throws(
			() =>
				checkSmokeTarget("https://staging-hooks.example.com", {
					worker: "hookflare",
					publicBaseUrl: "https://hooks.example.com",
				}),
			/smoke: .* does not match PUBLIC_BASE_URL https:\/\/hooks\.example\.com/,
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

describe("runSmoke edge cases", () => {
	it("runs with the default log and real sleep when nothing needs a retry", async () => {
		const api = {
			sinkUrl: "https://sink.example.com",
			ensureProject: async () => ({ id: "prj" }),
			ensureDestination: async (url) => {
				assert.match(
					url,
					/^https:\/\/sink\.example\.com\/r\/[0-9A-HJKMNP-TV-Z]+\/hook$/,
				);
				return { id: "dst" };
			},
			ensureSource: async () => ({ id: "src", ingress_url: "https://x" }),
			send: async () => "evt",
			deliveries: async () => [
				{ id: "dlv_1", status: "delivered" },
				{ id: "dlv_2", status: "delivered" },
			],
			replay: async () => ({ delivery_id: "dlv_2" }),
			sinkStats: async () => ({
				unique: 2,
				received: 2,
				ids: ["dlv_2", "dlv_1"],
			}),
		};
		const result = await runSmoke(api);
		assert.deepEqual(result.deliveryIds, ["dlv_1", "dlv_2"]);
		assert.match(result.sinkRun, /^[0-9A-HJKMNP-TV-Z]+$/);
	});

	it("throws when the initial delivery never arrives", async () => {
		const { api } = happyApi();
		api.deliveries = async () => [];
		const lines = [];
		await assert.rejects(
			runSmoke(api, (line) => lines.push(line), { sleep: async () => {} }),
			/^Error: smoke: event not delivered within 60s$/,
		);
		assert.deepEqual(lines, [
			"smoke: project prj_smoke",
			lines[1],
			"smoke: source src_smoke",
			"smoke: event evt_smoke",
		]);
		assert.match(lines[1], /^smoke: destination dst_smoke -> https:\/\/sink/);
	});

	it("waits for every initial delivery to be delivered", async () => {
		const { api } = happyApi();
		api.deliveries = async () => [
			{ id: "dlv_a", status: "delivered" },
			{ id: "dlv_b", status: "failed" },
		];
		await assert.rejects(
			runSmoke(api, () => {}, { sleep: async () => {} }),
			/smoke: event not delivered within 60s/,
		);
	});

	it("rethrows API errors while polling instead of reporting a timeout", async () => {
		const { api } = happyApi();
		api.deliveries = async () => {
			throw new Error("smoke: list deliveries failed with 500 boom");
		};
		await assert.rejects(
			runSmoke(api, () => {}, { sleep: async () => {} }),
			/^Error: smoke: list deliveries failed with 500 boom$/,
		);

		const second = happyApi().api;
		let polls = 0;
		second.deliveries = async () => {
			polls++;
			if (polls > 1) {
				throw new Error("network down");
			}
			return [{ id: "dlv_initial", status: "delivered" }];
		};
		await assert.rejects(
			runSmoke(second, () => {}, { sleep: async () => {} }),
			/^Error: network down$/,
		);
	});
});

describe("pollUntil timing", () => {
	it("sleeps between attempts but not after the last, then times out", async () => {
		const sleeps = [];
		let calls = 0;
		await assert.rejects(
			pollUntil(
				async (attempt) => {
					assert.equal(attempt, calls);
					calls++;
					return undefined;
				},
				{
					timeoutMs: 3000,
					intervalMs: 1000,
					sleep: async (ms) => sleeps.push(ms),
				},
			),
			/^Error: poll: timed out after 3000ms$/,
		);
		assert.equal(calls, 3);
		assert.deepEqual(sleeps, [1000, 1000]);
	});

	it("makes at least one attempt with a zero timeout and interval", async () => {
		let calls = 0;
		await assert.rejects(
			pollUntil(
				async () => {
					calls++;
					return null;
				},
				{
					timeoutMs: 0,
					intervalMs: 0,
					sleep: async () => assert.fail("slept"),
				},
			),
			/poll: timed out after 0ms/,
		);
		assert.equal(calls, 1);
	});

	it("uses a real timer by default", async () => {
		let calls = 0;
		const value = await pollUntil(async () => (++calls === 2 ? 0 : null), {
			timeoutMs: 10,
			intervalMs: 1,
		});
		assert.equal(value, 0);
		assert.equal(calls, 2);
	});
});

describe("signStandardWebhook with a bare secret and string body", () => {
	it("signs the UTF-8 bytes of a string body with the raw base64 key", async () => {
		const { createHmac } = await import("node:crypto");
		const key = Buffer.from("bare-secret-key");
		const expected = `v1,${createHmac("sha256", key).update('evt.1.{"é":1}').digest("base64")}`;
		assert.equal(
			await signStandardWebhook(key.toString("base64"), "evt", 1, '{"é":1}'),
			expected,
		);
	});
});

describe("smokeEnv project ID", () => {
	it("reads a trimmed per-worker smoke project ID and ignores a blank one", () => {
		const base = {
			HOOKFLARE_URL: "https://hooks.example.com",
			HOOKFLARE_API_TOKEN: "hf_test_token",
			SINK_URL: "https://sink.example.com",
		};
		assert.equal(
			smokeEnv({ ...base, HOOKFLARE_SMOKE_PROJECT_ID: "  prj_1 " })?.projectId,
			"prj_1",
		);
		assert.ok(
			!("projectId" in smokeEnv({ ...base, HOOKFLARE_SMOKE_PROJECT_ID: "  " })),
		);
	});
});

describe("httpSmokeApi ordering guards", () => {
	it("refuses steps that run before their prerequisites", async () => {
		const admin = fakeAdmin();
		const api = httpSmokeApi(smokeTestEnv, admin.fetchFn);
		await assert.rejects(
			api.ensureDestination("https://sink.example.com/r/x/hook"),
			/smoke: ensureProject must run first/,
		);
		await assert.rejects(
			api.ensureSource(),
			/smoke: ensureDestination must run first/,
		);
		await assert.rejects(api.send(), /smoke: ensureSource must run first/);
		await api.ensureProject("smoke");
		await assert.rejects(
			api.ensureSource(),
			/smoke: ensureDestination must run first/,
		);
		assert.deepEqual(
			admin.mutations.map((m) => `${m.method} ${m.path}`),
			["POST /projects"],
		);
	});
});

describe("httpSmokeApi requests", () => {
	function routed(routes) {
		const calls = [];
		const fetchFn = async (url, init = {}) => {
			const key = `${init.method ?? "GET"} ${url}`;
			calls.push({ key, init });
			if (!(key in routes)) {
				throw new Error(`unexpected ${key}`);
			}
			const route = routes[key];
			return typeof route === "function"
				? route()
				: new Response(JSON.stringify(route), { status: 200 });
		};
		return { calls, fetchFn };
	}

	const base = "https://api.example.com/api/admin/v1";

	it("lists an event's deliveries and replays it with an audit reason", async () => {
		const { calls, fetchFn } = routed({
			[`GET ${base}/events/evt_1/deliveries`]: {
				data: [
					{ id: "dlv_1", status: "delivered", attempt_count: 1 },
					{ id: "dlv_2", status: "pending" },
				],
			},
			[`POST ${base}/events/evt_1/replay`]: {
				delivery_id: "dlv_3",
				extra: true,
			},
		});
		const api = httpSmokeApi(
			{ ...smokeTestEnv, url: "https://api.example.com/" },
			fetchFn,
		);
		assert.deepEqual(await api.deliveries("evt_1"), [
			{ id: "dlv_1", status: "delivered" },
			{ id: "dlv_2", status: "pending" },
		]);
		assert.deepEqual(await api.replay("evt_1"), { delivery_id: "dlv_3" });
		assert.equal(calls[0].init.headers.authorization, "Bearer hf_test_token");
		assert.deepEqual(JSON.parse(calls[1].init.body), {
			reason: "post-deploy smoke test",
		});
	});

	it("treats a missing data array or ids list as empty", async () => {
		const { fetchFn } = routed({
			[`GET ${base}/events/evt_1/deliveries`]: {},
			"GET https://sink.example.com/r/run1/stats?ids=1": {
				unique: 0,
				received: 0,
			},
			[`GET ${base}/projects?limit=100`]: {},
			[`POST ${base}/projects`]: { id: "prj_new" },
		});
		const api = httpSmokeApi(
			{ ...smokeTestEnv, sinkUrl: "https://sink.example.com/" },
			fetchFn,
		);
		assert.equal(api.sinkUrl, "https://sink.example.com");
		assert.deepEqual(await api.deliveries("evt_1"), []);
		assert.deepEqual(await api.sinkStats("run1"), {
			unique: 0,
			received: 0,
			ids: [],
		});
		assert.deepEqual(await api.ensureProject("smoke"), { id: "prj_new" });
	});

	it("reports the status and a truncated body for a failed call", async () => {
		const { fetchFn } = routed({
			[`POST ${base}/events/evt_1/replay`]: () =>
				new Response("x".repeat(300), { status: 409 }),
			[`GET ${base}/events/evt_2/deliveries`]: () => ({
				ok: false,
				status: 503,
				text: async () => {
					throw new Error("body stream broke");
				},
			}),
		});
		const api = httpSmokeApi(smokeTestEnv, fetchFn);
		await assert.rejects(api.replay("evt_1"), (err) => {
			assert.equal(
				err.message,
				`smoke: replay event failed with 409 ${"x".repeat(200)}`,
			);
			return true;
		});
		await assert.rejects(
			api.deliveries("evt_2"),
			/^Error: smoke: list deliveries failed with 503 $/,
		);
	});

	it("reports a rejected ingress send with its status", async () => {
		const admin = fakeAdmin();
		const fetchFn = async (url, init) =>
			new URL(url).origin === "https://hooks.example.com"
				? new Response('{"error":"bad signature"}', { status: 401 })
				: admin.fetchFn(url, init);
		const api = httpSmokeApi(smokeTestEnv, fetchFn);
		await api.ensureProject("smoke");
		await api.ensureDestination("https://sink.example.com/r/run/hook");
		await api.ensureSource();
		await assert.rejects(
			api.send(),
			/smoke: send event failed with 401 \{"error":"bad signature"\}/,
		);
	});
});

describe("httpSmokeApi source reuse", () => {
	it("re-enables, repoints, and fixes the auth config of a reused source", async () => {
		const admin = fakeAdmin({
			projects: [{ id: "prj_smoke", name: "smoke" }],
			destinations: [
				{
					id: "dst_cur",
					project_id: "prj_smoke",
					name: "smoke",
					url: "https://sink.example.com/r/run/hook",
				},
			],
			sources: [
				{
					id: "src_other",
					project_id: "prj_smoke",
					name: "not-smoke",
					auth_type: "hmac",
				},
				{
					id: "src_old",
					project_id: "prj_smoke",
					destination_id: "dst_gone",
					name: "smoke",
					status: "disabled",
					auth_type: "hmac",
					auth_config: { ...hmacConfig, encoding: "base64" },
					ingress_url: "https://hooks.example.com/in/src_old",
				},
			],
		});
		const api = httpSmokeApi(smokeTestEnv, admin.fetchFn);
		await api.ensureProject("smoke");
		await api.ensureDestination("https://sink.example.com/r/run/hook");
		await api.ensureSource();
		assert.deepEqual(
			admin.mutations.map((m) => `${m.method} ${m.path}`),
			["PATCH /sources/src_old", "POST /sources/src_old/rotate-secret"],
		);
		assert.deepEqual(admin.mutations[0].body, {
			destination_id: "dst_cur",
			status: "active",
			auth_config: hmacConfig,
			reason: "post-deploy smoke test",
		});
	});
});

describe("runId", () => {
	const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

	it("starts with the 10-char Crockford timestamp and sorts by time", (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: 1729094400000 });
		const first = runId();
		t.mock.timers.tick(1);
		const second = runId();
		let time = 0;
		for (const ch of first.slice(0, 10)) {
			time = time * 32 + CROCKFORD.indexOf(ch);
		}
		assert.equal(time, 1729094400000);
		assert.ok(first < second, `${first} !< ${second}`);
		assert.match(first, /^[0-9A-HJKMNP-TV-Z]+$/);
	});

	it("is a 26-char ULID with 80 bits of randomness, as documented", () => {
		assert.match(runId(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
	});
});
