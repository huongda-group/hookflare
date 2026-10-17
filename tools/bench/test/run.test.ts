import { describe, expect, it } from "vitest";
import { productionTarget } from "../src/guard";
import {
	accountDelivery,
	isDrained,
	main,
	overviewUrl,
	type RunDeps,
	sendOne,
	sinkQuery,
} from "../src/run";

describe("isDrained", () => {
	it("is true when no live status remains", () => {
		expect(
			isDrained({
				pending: 0,
				queued: 0,
				in_flight: 0,
				retrying: 0,
				paused: 0,
			}),
		).toBe(true);
		expect(isDrained({})).toBe(true);
	});

	it("is false when any backlog counter is non-zero, including in_flight and paused", () => {
		expect(isDrained({ pending: 1 })).toBe(false);
		expect(isDrained({ queued: 2 })).toBe(false);
		expect(isDrained({ retrying: 5 })).toBe(false);
		expect(isDrained({ in_flight: 1 })).toBe(false);
		expect(isDrained({ paused: 3 })).toBe(false);
	});
});

describe("overviewUrl", () => {
	it("scopes the overview to the bench project", () => {
		expect(overviewUrl("https://h.example", "prj_1")).toBe(
			"https://h.example/api/admin/v1/overview?project_id=prj_1",
		);
	});
});

describe("sinkQuery", () => {
	it("renders delay and failure params", () => {
		expect(sinkQuery({})).toBe("");
		expect(sinkQuery({ delay_ms: 100, fail_pct: 30 })).toBe(
			"?delay_ms=100&fail_pct=30",
		);
	});
});

describe("sendOne", () => {
	const source = {
		id: "src_1",
		ingress_url: "https://h.example/in/src_1",
		secret: "c2VjcmV0",
	};

	function clock(start: number) {
		let t = start;
		return {
			now: () => t,
			advance: (ms: number) => {
				t += ms;
			},
		};
	}

	it("measures latency from the scheduled time and records lateness", async () => {
		const c = clock(1250);
		const fetchFn = (async () => {
			c.advance(40);
			return new Response("ok", { status: 202 });
		}) as typeof fetch;
		const r = await sendOne(source, "{}", "id-1", {
			scheduledAt: 1000,
			t0: 0,
			now: c.now,
			fetch: fetchFn,
		});
		expect(r).toEqual({
			status: 202,
			kind: "http",
			ms: 290,
			late_ms: 250,
			sent_at: 1250,
		});
	});

	it("classifies timeouts and network errors", async () => {
		const c = clock(0);
		const timeout = await sendOne(source, "{}", "id", {
			scheduledAt: 0,
			t0: 0,
			now: c.now,
			fetch: (async () => {
				throw new DOMException("timed out", "TimeoutError");
			}) as typeof fetch,
		});
		expect(timeout.kind).toBe("timeout");
		expect(timeout.status).toBe(0);
		const network = await sendOne(source, "{}", "id", {
			scheduledAt: 0,
			t0: 0,
			now: c.now,
			fetch: (async () => {
				throw new TypeError("fetch failed");
			}) as typeof fetch,
		});
		expect(network.kind).toBe("network");
	});
});

describe("accountDelivery", () => {
	it("reports lost only after a finished drain", () => {
		expect(accountDelivery(100, { unique: 98, received: 99 }, true)).toEqual({
			accepted: 100,
			sink_unique: 98,
			sink_received: 99,
			unique_minus_accepted: -2,
			lost: 2,
			lost_note: null,
		});
		expect(accountDelivery(100, { unique: 98, received: 98 }, false)).toEqual({
			accepted: 100,
			sink_unique: 98,
			sink_received: 98,
			unique_minus_accepted: -2,
			lost: null,
			lost_note: "drain timed out",
		});
	});

	it("never reports negative loss when non-202 sends were delivered later", () => {
		const r = accountDelivery(100, { unique: 103, received: 103 }, true);
		expect(r.lost).toBe(0);
		expect(r.unique_minus_accepted).toBe(3);
		expect(r.lost_note).toMatch(/lower bound/);
	});
});

describe("main", () => {
	const PROD = JSON.stringify({
		name: "hookflare",
		vars: { PUBLIC_BASE_URL: "https://hooks.example.com" },
		d1_databases: [
			{ binding: "DB", database_name: "hookflare", database_id: "prod-id" },
		],
	});
	const scenario = JSON.stringify({
		name: "t",
		steps: [{ rate_per_s: 10, duration_s: 10 }],
		sources: 1,
		body_bytes: 1024,
		sink: {},
		drain_timeout_s: 60,
	});

	function harness(url: string) {
		const lines: string[] = [];
		const fetched: string[] = [];
		const deps: RunDeps = {
			env: {
				HOOKFLARE_URL: url,
				HOOKFLARE_API_TOKEN: "hf_test_token",
				SINK_URL: "https://sink.example",
			},
			readFile: async () => scenario,
			production: productionTarget(PROD),
			fetch: (async (input: string | URL | Request) => {
				fetched.push(String(input));
				throw new Error("no network in tests");
			}) as typeof fetch,
			log: (line) => {
				lines.push(line);
			},
			exit: (code) => {
				throw new Error(`exit ${code}`);
			},
		};
		return { lines, fetched, deps };
	}

	it("prints the cost estimate and stops without --yes", async () => {
		const h = harness("https://hookflare-staging.acme.workers.dev");
		await main(["s.json"], h.deps);
		expect(h.fetched).toEqual([]);
		const text = h.lines.join("\n");
		expect(text).toMatch(/requests\s+100/);
		expect(text).toMatch(/--yes/);
	});

	it("--estimate needs no environment", async () => {
		const h = harness("");
		h.deps.env = {};
		await main(["s.json", "--estimate"], h.deps);
		expect(h.fetched).toEqual([]);
		expect(h.lines.join("\n")).toMatch(/total \(gross\)/);
	});

	it("refuses a production URL even with --yes", async () => {
		for (const url of [
			"https://hooks.example.com",
			"https://hookflare.acme.workers.dev",
		]) {
			const h = harness(url);
			await expect(main(["s.json", "--yes"], h.deps)).rejects.toThrow("exit 2");
			expect(h.fetched).toEqual([]);
			expect(h.lines.join("\n")).toMatch(/production/);
		}
	});

	it("needs HOOKFLARE_API_TOKEN with --yes", async () => {
		const h = harness("https://hookflare-staging.acme.workers.dev");
		h.deps.env = {
			HOOKFLARE_URL: "https://hookflare-staging.acme.workers.dev",
			SINK_URL: "https://sink.example",
		};
		await expect(main(["s.json", "--yes"], h.deps)).rejects.toThrow("exit 2");
		expect(h.fetched).toEqual([]);
		expect(h.lines.join("\n")).toMatch(/HOOKFLARE_API_TOKEN/);
	});

	it("provisions with the API token as a Bearer authorization header", async () => {
		const h = harness("https://hookflare-staging.acme.workers.dev");
		const tiny = JSON.stringify({
			name: "t",
			steps: [{ rate_per_s: 1, duration_s: 1 }],
			sources: 1,
			body_bytes: 8,
			sink: {},
			drain_timeout_s: 1,
		});
		h.deps.readFile = async () => tiny;
		const seen: Record<string, string>[] = [];
		h.deps.fetch = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = String(input);
			if (url.includes("/api/admin/v1/")) {
				seen.push({ ...(init?.headers as Record<string, string>) });
				if (url.endsWith("/projects")) {
					return new Response(JSON.stringify({ id: "prj_1" }), {
						status: 201,
					});
				}
				if (url.endsWith("/destinations")) {
					return new Response(JSON.stringify({ id: "dst_1" }), {
						status: 201,
					});
				}
				if (url.endsWith("/sources")) {
					return new Response(
						JSON.stringify({
							id: "src_1",
							ingress_url: "https://h.example/in/src_1",
						}),
						{ status: 201 },
					);
				}
			}
			throw new Error("boom");
		}) as typeof fetch;
		// Provision succeeds, then the first send's fetch throws "boom":
		// sendOne records it as a network error, the drain polls fail
		// closed, and the sink stats fetch lets "boom" escape.
		await expect(main(["s.json", "--yes"], h.deps)).rejects.toThrow("boom");
		expect(seen.length).toBeGreaterThan(0);
		for (const headers of seen) {
			expect(headers["authorization"]).toBe("Bearer hf_test_token");
			expect(headers).not.toHaveProperty("CF-Access-Client-Id");
			expect(headers).not.toHaveProperty("CF-Access-Client-Secret");
		}
	});
});
