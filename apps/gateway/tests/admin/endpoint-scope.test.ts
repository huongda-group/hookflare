import type { DestinationStats, Page } from "@hookflare/shared";
import { expect, it, vi } from "vitest";
import {
	auditLogs,
	destinations,
	sources,
	testDeliveries,
} from "../../src/core/db/schema";
import { adminApp } from "../helpers/admin";
import { testDeps } from "../helpers/deps";
import { seedPipeline } from "../helpers/seed";

it("scopes endpoint collections and stats before paging", async () => {
	const deps = testDeps();
	const a = await seedPipeline(deps);
	await seedPipeline(deps);
	const api = await adminApp(deps);
	for (const [kind, id] of [
		["sources", a.source.id],
		["destinations", a.destination.id],
	]) {
		const res = await api.request(
			"GET",
			`/${kind}?project_id=${a.project.id}&limit=1`,
		);
		const { data, next_cursor } =
			await res.json<Page<{ id: string; project_id: string }>>();
		expect(res.status).toBe(200);
		expect(data).toMatchObject([{ id, project_id: a.project.id }]);
		expect(next_cursor).toBeNull();
	}
	const res = await api.request(
		"GET",
		`/destinations/stats?project_id=${a.project.id}`,
	);
	expect(res.status).toBe(200);
	const { data } = await res.json<{ data: DestinationStats[] }>();
	expect(data.map((row) => row.destination_id)).toEqual([a.destination.id]);
});

it.each([
	{ kind: "sources", method: "GET", suffix: "" },
	{ kind: "sources", method: "PATCH", suffix: "", body: { name: "Other" } },
	{ kind: "sources", method: "POST", suffix: "/rotate-secret" },
	{ kind: "destinations", method: "GET", suffix: "" },
	{
		kind: "destinations",
		method: "PATCH",
		suffix: "",
		body: { name: "Other" },
	},
	{ kind: "destinations", method: "POST", suffix: "/rotate-secret" },
	{ kind: "destinations", method: "POST", suffix: "/pause" },
	{ kind: "destinations", method: "POST", suffix: "/resume" },
	{ kind: "destinations", method: "POST", suffix: "/test" },
	{ kind: "destinations", method: "GET", suffix: "/tests" },
] as const)(
	"rejects a project mismatch for $method /$kind/:id$suffix",
	async (testCase) => {
		const { kind, method, suffix } = testCase;
		const body = "body" in testCase ? testCase.body : undefined;
		const fetch = vi.fn(async () => new Response("ok"));
		const deps = testDeps({ fetch });
		const a = await seedPipeline(deps);
		const b = await seedPipeline(deps, {
			destination: { status: suffix === "/resume" ? "paused" : "active" },
			source: {
				authType: "token",
				authConfig: { in: "header", name: "x-token" },
			},
		});
		const api = await adminApp(deps);
		const before = await deps.db.select().from(auditLogs);
		const id = kind === "sources" ? b.source.id : b.destination.id;
		const path = `/${kind}/${id}${suffix}`;
		const res = await api.request(
			method,
			`${path}?project_id=${a.project.id}`,
			body,
		);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "not_found" });
		expect(await deps.db.select().from(auditLogs)).toEqual(before);
		expect(await deps.db.select().from(testDeliveries)).toEqual([]);
		expect(await deps.db.select().from(sources)).toEqual(
			expect.arrayContaining([b.source]),
		);
		expect(await deps.db.select().from(destinations)).toEqual(
			expect.arrayContaining([b.destination]),
		);
		expect(fetch).not.toHaveBeenCalled();
		if (method === "GET") {
			const matched = await api.request(
				method,
				`${path}?project_id=${b.project.id}`,
			);
			expect(matched.status).toBe(200);
		}
	},
);

it.each(["sources", "destinations"])(
	"rejects creating %s when the body and query projects differ",
	async (kind) => {
		const deps = testDeps();
		const a = await seedPipeline(deps);
		const b = await seedPipeline(deps);
		const api = await adminApp(deps);
		const before = await deps.db.select().from(auditLogs);
		const beforeSources = await deps.db.select().from(sources);
		const beforeDestinations = await deps.db.select().from(destinations);
		const res = await api.request(
			"POST",
			`/${kind}?project_id=${a.project.id}`,
			{
				project_id: b.project.id,
				name: "Mismatch",
				...(kind === "sources"
					? {
							destination_id: b.destination.id,
							auth_type: "none",
							auth_config: {},
						}
					: { url: "https://api.example.com/hooks" }),
			},
		);
		expect(res.status).toBe(400);
		expect(await deps.db.select().from(auditLogs)).toEqual(before);
		expect(await deps.db.select().from(sources)).toEqual(beforeSources);
		expect(await deps.db.select().from(destinations)).toEqual(
			beforeDestinations,
		);
	},
);
