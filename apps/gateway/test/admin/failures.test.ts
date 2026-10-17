import type { Failure } from "@hookflare/shared";
import { describe, expect, it } from "vitest";
import { deliveries } from "../../src/core/db/schema";
import { newId } from "../../src/core/ids";
import { adminApp } from "../helpers/admin";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

type Page = { data: Failure[]; next_cursor: string | null };

async function fixture() {
	const deps = testDeps();
	const p = await seedPipeline(deps);
	const t = 1_800_000_000_000 + Math.floor(Math.random() * 1e9);
	const dead = await seedDelivery(deps, p, {
		status: "dead",
		delivery: { completedAt: t + 2000, lastError: "boom" },
	});
	const final = await seedDelivery(deps, p, {
		status: "failed_final",
		delivery: { completedAt: t + 1000 },
	});
	await seedDelivery(deps, p, {
		status: "delivered",
		delivery: { completedAt: t },
	});
	const api = await adminApp(deps, { role: "viewer" });
	return { deps, p, t, dead, final, api };
}

describe("GET /failures", () => {
	it("lists failed_final and dead deliveries, newest completion first", async () => {
		const { p, dead, final, api } = await fixture();
		const page = await (
			await api.request("GET", `/failures?destination_id=${p.destination.id}`)
		).json<Page>();
		expect(page.data.map((f) => f.id)).toEqual([
			dead.deliveryId,
			final.deliveryId,
		]);
		expect(page.data[0]).toMatchObject({
			event_id: dead.eventId,
			source_id: p.source.id,
			status: "dead",
			last_error: "boom",
			latest_replay: null,
		});
	});

	it("hides a failure with a newer replay unless unresolved=false", async () => {
		const { deps, p, dead, final, api } = await fixture();
		const replayId = newId("dlv", deps.now() + 10);
		await deps.db.insert(deliveries).values({
			id: replayId,
			eventId: dead.eventId,
			destinationId: p.destination.id,
			projectId: p.project.id,
			kind: "replay",
			status: "delivered",
			attemptCount: 1,
			createdAt: deps.now(),
		});
		const unresolved = await (
			await api.request("GET", `/failures?destination_id=${p.destination.id}`)
		).json<Page>();
		expect(unresolved.data.map((f) => f.id)).toEqual([final.deliveryId]);
		const all = await (
			await api.request(
				"GET",
				`/failures?destination_id=${p.destination.id}&unresolved=false`,
			)
		).json<Page>();
		expect(all.data[0]).toMatchObject({
			id: dead.deliveryId,
			latest_replay: { id: replayId, status: "delivered" },
		});
	});

	it("keeps a failure visible while its replay is still in flight", async () => {
		const { deps, p, dead, api } = await fixture();
		const replayId = newId("dlv", deps.now() + 10);
		await deps.db.insert(deliveries).values({
			id: replayId,
			eventId: dead.eventId,
			destinationId: p.destination.id,
			projectId: p.project.id,
			kind: "replay",
			status: "paused",
			attemptCount: 0,
			createdAt: deps.now(),
		});
		const page = await (
			await api.request("GET", `/failures?destination_id=${p.destination.id}`)
		).json<Page>();
		expect(page.data.find((f) => f.id === dead.deliveryId)).toMatchObject({
			latest_replay: { id: replayId, status: "paused" },
		});
	});

	it("filters by status and pages with a cursor", async () => {
		const { p, dead, final, api } = await fixture();
		const onlyDead = await (
			await api.request(
				"GET",
				`/failures?destination_id=${p.destination.id}&status=dead`,
			)
		).json<Page>();
		expect(onlyDead.data.map((f) => f.id)).toEqual([dead.deliveryId]);
		const first = await (
			await api.request(
				"GET",
				`/failures?destination_id=${p.destination.id}&limit=1`,
			)
		).json<Page>();
		const second = await (
			await api.request(
				"GET",
				`/failures?destination_id=${p.destination.id}&limit=1&cursor=${first.next_cursor}`,
			)
		).json<Page>();
		expect([...first.data, ...second.data].map((f) => f.id)).toEqual([
			dead.deliveryId,
			final.deliveryId,
		]);
		expect(second.next_cursor).toBeNull();
	});
});
