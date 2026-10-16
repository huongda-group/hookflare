import type { Overview } from "@hookflare/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { clearAccessKeyCache } from "../../src/admin/auth/access";
import { destinations, statsHourly } from "../../src/core/db/schema";
import { floorHour, HOUR_MS } from "../../src/core/db/stats";
import { newId } from "../../src/core/ids";
import { adminApp } from "../helpers/admin";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

beforeEach(() => {
	clearAccessKeyCache();
});

const T = floorHour(1_900_000_000_000);
const NOW = T + 30 * 60_000;

async function fixture() {
	const deps = { ...testDeps(), now: () => NOW };
	const p = await seedPipeline(deps);
	const row = (hour: number, c: Partial<typeof statsHourly.$inferInsert>) =>
		deps.db.insert(statsHourly).values({
			hour,
			projectId: p.project.id,
			sourceId: p.source.id,
			destinationId: p.destination.id,
			...c,
		});
	await row(T, {
		received: 10,
		delivered: 6,
		failedFinal: 1,
		dead: 1,
		attempts: 12,
	});
	await row(T - 2 * HOUR_MS, { received: 4, delivered: 4, attempts: 4 });
	await row(T - 24 * HOUR_MS, { received: 100, delivered: 100 }); // outside 24h
	const api = await adminApp(deps, { role: "viewer" });
	const get = async (q: string) =>
		(
			await api.request("GET", `/overview?project_id=${p.project.id}${q}`)
		).json<Overview>();
	return { deps, p, api, get };
}

describe("GET /overview", () => {
	it("sums the window and computes the success rate", async () => {
		const { get } = await fixture();
		const o = await get("");
		expect(o.range).toBe("24h");
		expect(o.from).toBe(T - 23 * HOUR_MS);
		expect(o.to).toBe(T + HOUR_MS);
		expect(o.generated_at).toBe(NOW);
		expect(o.totals).toEqual({
			received: 14,
			delivered: 10,
			failed_final: 1,
			dead: 1,
			attempts: 16,
			success_rate: 10 / 12,
		});
	});

	it("returns one trend point per hour, zeros included", async () => {
		const { get } = await fixture();
		const o = await get("");
		expect(o.trend).toHaveLength(24);
		expect(o.trend[0]).toEqual({
			hour: T - 23 * HOUR_MS,
			received: 0,
			delivered: 0,
			failed: 0,
		});
		expect(o.trend[21]).toEqual({
			hour: T - 2 * HOUR_MS,
			received: 4,
			delivered: 4,
			failed: 0,
		});
		expect(o.trend[23]).toEqual({
			hour: T,
			received: 10,
			delivered: 6,
			failed: 2,
		});
		expect((await get("&range=7d")).trend).toHaveLength(168);
	});

	it("counts live statuses regardless of range", async () => {
		const { deps, p, get } = await fixture();
		await seedDelivery(deps, p, { status: "retrying" });
		await seedDelivery(deps, p, { status: "paused" });
		await seedDelivery(deps, p, { status: "delivered" });
		const o = await get("");
		expect(o.live).toEqual({
			pending: 0,
			queued: 0,
			in_flight: 0,
			retrying: 1,
			paused: 1,
		});
	});

	it("returns zeros and a null success rate for an empty project", async () => {
		const deps = { ...testDeps(), now: () => NOW };
		const p = await seedPipeline(deps);
		const api = await adminApp(deps, { role: "viewer" });
		const o = await (
			await api.request("GET", `/overview?project_id=${p.project.id}`)
		).json<Overview>();
		expect(o.totals.success_rate).toBeNull();
		expect(o.totals.received).toBe(0);
		expect(o.trend.every((t) => t.received === 0)).toBe(true);
		expect(o.failing_destinations).toEqual([]);
	});

	it("lists failing destinations by failures, top 5, omitting zero", async () => {
		const deps = { ...testDeps(), now: () => NOW };
		const p = await seedPipeline(deps);
		const ids: string[] = [];
		for (let i = 0; i < 7; i++) {
			const id = newId("dst", NOW + i);
			ids.push(id);
			await deps.db
				.insert(destinations)
				.values({ ...p.destination, id, name: `d${i}` });
			await deps.db.insert(statsHourly).values({
				hour: T,
				projectId: p.project.id,
				sourceId: p.source.id,
				destinationId: id,
				dead: i, // d0 has no failures
				delivered: 1,
			});
		}
		const api = await adminApp(deps, { role: "viewer" });
		const o = await (
			await api.request("GET", `/overview?project_id=${p.project.id}`)
		).json<Overview>();
		expect(o.failing_destinations.map((f) => f.name)).toEqual([
			"d6",
			"d5",
			"d4",
			"d3",
			"d2",
		]);
		expect(o.failing_destinations[0]).toEqual({
			destination_id: ids[6],
			name: "d6",
			failed: 6,
			delivered: 1,
		});
	});

	it("rejects an unknown range", async () => {
		const { api } = await fixture();
		expect((await api.request("GET", "/overview?range=1y")).status).toBe(400);
	});
});
