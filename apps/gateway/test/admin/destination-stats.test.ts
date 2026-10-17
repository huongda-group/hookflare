import type { DestinationStats } from "@hookflare/shared";
import { describe, expect, it } from "vitest";
import { destinations, statsHourly } from "../../src/core/db/schema";
import { floorHour } from "../../src/core/db/stats";
import { newId } from "../../src/core/ids";
import { adminApp } from "../helpers/admin";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

describe("GET /destinations/stats", () => {
	it("combines window counts with the newest terminal delivery", async () => {
		const t = Date.now();
		const deps = { ...testDeps(), now: () => t };
		const p = await seedPipeline(deps);
		const quiet = newId("dst", deps.now() + 1);
		await deps.db
			.insert(destinations)
			.values({ ...p.destination, id: quiet, name: "quiet" });
		await deps.db.insert(statsHourly).values({
			hour: floorHour(deps.now()),
			projectId: p.project.id,
			sourceId: p.source.id,
			destinationId: p.destination.id,
			delivered: 3,
			failedFinal: 1,
		});
		await seedDelivery(deps, p, {
			status: "delivered",
			delivery: {
				createdAt: deps.now() - 2000,
				completedAt: deps.now() - 1500,
				lastHttpStatus: 200,
			},
		});
		await seedDelivery(deps, p, {
			status: "failed_final",
			delivery: {
				createdAt: deps.now() - 1000,
				completedAt: deps.now() - 500,
				lastHttpStatus: 410,
				lastError: "gone",
			},
		});
		await seedDelivery(deps, p, { status: "retrying" }); // newest, not terminal

		const api = await adminApp(deps, { role: "viewer" });
		const res = await api.request(
			"GET",
			`/destinations/stats?project_id=${p.project.id}`,
		);
		expect(res.status).toBe(200);
		const { data } = await res.json<{ data: DestinationStats[] }>();
		const byId = new Map(data.map((d) => [d.destination_id, d]));
		expect(byId.get(p.destination.id)).toEqual({
			destination_id: p.destination.id,
			delivered: 3,
			failed: 1,
			success_rate: 0.75,
			last_delivery_at: deps.now() - 500,
			last_http_status: 410,
			last_error: "gone",
		});
		expect(byId.get(quiet)).toEqual({
			destination_id: quiet,
			delivered: 0,
			failed: 0,
			success_rate: null,
			last_delivery_at: null,
			last_http_status: null,
			last_error: null,
		});
	});

	it("is not shadowed by GET /destinations/:id", async () => {
		const api = await adminApp(testDeps(), { role: "viewer" });
		const res = await api.request("GET", "/destinations/stats");
		expect(res.status).toBe(200);
	});
});
