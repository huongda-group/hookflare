import { describe, expect, it } from "vitest";
import { productionTarget } from "../src/guard";
import {
	b5Queries,
	formatReport,
	main,
	type QueryDeps,
	timeQuery,
} from "../src/queries";

describe("b5Queries", () => {
	it("covers the spec §6 B5 read paths and scopes them when ids are given", () => {
		const all = b5Queries({});
		const names = all.map((q) => q.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"events: latest page",
				"events: status=dead",
				"events: http_status=500",
				"failures: unresolved",
				"failures: dead",
				"overview: 24h",
				"overview: 30d",
				"destinations: stats",
				"archives: preview",
			]),
		);
		for (const q of all) expect(q.path.startsWith("/api/admin/v1/")).toBe(true);

		// provider_event_id requires source_id in the API.
		expect(names).not.toContain("events: provider_event_id miss");

		const scoped = b5Queries({ projectId: "prj_1", sourceId: "src_1" });
		expect(
			scoped.find((q) => q.name === "events: provider_event_id miss")?.path,
		).toBe(
			"/api/admin/v1/events?provider_event_id=b5-no-such-event&project_id=prj_1&source_id=src_1",
		);
		expect(
			scoped.find((q) => q.name === "events: failed_final, last 7 days")?.path,
		).toMatch(/from=-7d/);
		const dead = scoped.find((q) => q.name === "events: status=dead");
		expect(dead?.path).toBe(
			"/api/admin/v1/events?status=dead&project_id=prj_1&source_id=src_1",
		);
		expect(scoped.find((q) => q.name === "overview: 30d")?.path).toBe(
			"/api/admin/v1/overview?range=30d&project_id=prj_1",
		);
	});
});

describe("timeQuery", () => {
	it("times each repetition and reports p50/p95 and statuses", async () => {
		let t = 0;
		const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
		let call = 0;
		const seen: { url: string; headers: Record<string, string> }[] = [];
		const fetchFn = (async (url: string, init?: RequestInit) => {
			seen.push({
				url,
				headers: init?.headers as Record<string, string>,
			});
			t += durations[call++];
			return new Response("{}", { status: call === 10 ? 500 : 200 });
		}) as unknown as typeof fetch;
		const r = await timeQuery(
			{ name: "q", path: "/api/admin/v1/overview" },
			{
				base: "https://h.example",
				headers: { authorization: "Bearer hf_test_token" },
				reps: 10,
				fetch: fetchFn,
				now: () => t,
			},
		);
		expect(seen).toHaveLength(10);
		expect(seen[0].url).toBe("https://h.example/api/admin/v1/overview");
		expect(seen[0].headers["authorization"]).toBe("Bearer hf_test_token");
		expect(r.p50).toBe(50);
		expect(r.p95).toBe(100);
		expect(r.max).toBe(100);
		expect(r.by_status).toEqual({ "200": 9, "500": 1 });
	});

	it("records network errors without throwing", async () => {
		const r = await timeQuery(
			{ name: "q", path: "/x" },
			{
				base: "https://h.example",
				headers: {},
				reps: 2,
				fetch: (async () => {
					throw new TypeError("fetch failed");
				}) as typeof fetch,
				now: () => 0,
			},
		);
		expect(r.by_status).toEqual({ error: 2 });
	});
});

describe("formatReport", () => {
	it("prints one line per query", () => {
		const text = formatReport([
			{
				name: "a",
				path: "/a",
				p50: 12.3,
				p95: 45.6,
				max: 50,
				by_status: { "200": 3 },
			},
		]);
		expect(text).toMatch(/a\s+p50 12 ms\s+p95 46 ms\s+max 50 ms\s+200×3/);
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

	function harness(url: string) {
		const lines: string[] = [];
		const fetched: string[] = [];
		const headers: Record<string, string>[] = [];
		const deps: QueryDeps = {
			env: {
				HOOKFLARE_URL: url,
				HOOKFLARE_API_TOKEN: "hf_test_token",
			},
			production: productionTarget(PROD),
			fetch: (async (input: string, init?: RequestInit) => {
				fetched.push(input);
				headers.push({ ...(init?.headers as Record<string, string>) });
				return new Response("{}", { status: 200 });
			}) as unknown as typeof fetch,
			now: () => 0,
			log: (line) => {
				lines.push(line);
			},
			exit: (code) => {
				throw new Error(`exit ${code}`);
			},
		};
		return { lines, fetched, headers, deps };
	}

	it("runs every query --reps times against a staging URL", async () => {
		const h = harness("https://hookflare-staging.acme.workers.dev/");
		await main(["--reps", "2"], h.deps);
		expect(h.fetched.length).toBe(b5Queries({}).length * 2);
		expect(h.fetched[0]).toMatch(
			/^https:\/\/hookflare-staging\.acme\.workers\.dev\/api\/admin\/v1\//,
		);
		expect(h.lines.join("\n")).toMatch(/p95/);
	});

	it("sends the API token as a Bearer authorization header", async () => {
		const h = harness("https://hookflare-staging.acme.workers.dev/");
		await main(["--reps", "1"], h.deps);
		expect(h.headers.length).toBeGreaterThan(0);
		for (const seen of h.headers) {
			expect(seen["authorization"]).toBe("Bearer hf_test_token");
			expect(seen).not.toHaveProperty("CF-Access-Client-Id");
			expect(seen).not.toHaveProperty("CF-Access-Client-Secret");
		}
	});

	it("fails without HOOKFLARE_API_TOKEN", async () => {
		const h = harness("https://hookflare-staging.acme.workers.dev/");
		h.deps.env = {
			HOOKFLARE_URL: "https://hookflare-staging.acme.workers.dev/",
		};
		await expect(main([], h.deps)).rejects.toThrow("exit 2");
		expect(h.fetched).toEqual([]);
	});

	it("refuses a production URL", async () => {
		const h = harness("https://hookflare.acme.workers.dev");
		await expect(main([], h.deps)).rejects.toThrow("exit 2");
		expect(h.fetched).toEqual([]);
		expect(h.lines.join("\n")).toMatch(/production/);
	});
});
