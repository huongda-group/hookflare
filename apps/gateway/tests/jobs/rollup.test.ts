import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
	deliveries,
	deliveryAttempts,
	settings,
	statsHourly,
} from "../../src/core/db/schema";
import { floorHour, HOUR_MS } from "../../src/core/db/stats";
import { newId } from "../../src/core/ids";
import { createLogger } from "../../src/core/log";
import type { Deps } from "../../src/deps";
import { BACKFILL_KEY, rollup } from "../../src/jobs/rollup";
import { testDeps } from "../helpers/deps";
import { faultyDeps } from "../helpers/faults";
import { type Pipeline, seedDelivery, seedPipeline } from "../helpers/seed";

const logger = createLogger({ LOG_LEVEL: "error" });
/** A fixed UTC hour; every test uses its own project, so rows never collide. */
const T = floorHour(1_900_000_000_000);
const at = (ms: number) => ({ ...testDeps(), now: () => ms });

beforeEach(async () => {
	// Skip the backfill here; rollup-backfill.test.ts covers it.
	await testDeps()
		.db.insert(settings)
		.values({ key: BACKFILL_KEY, valueJson: '"done"', updatedAt: 0 })
		.onConflictDoUpdate({
			target: settings.key,
			set: { valueJson: '"done"' },
		});
});

async function attempt(
	deps: Deps,
	deliveryId: string,
	no: number,
	startedAt: number,
) {
	await deps.db.insert(deliveryAttempts).values({
		id: newId("att", startedAt),
		deliveryId,
		attemptNo: no,
		startedAt,
		durationMs: 10,
		httpStatus: 503,
	});
}

async function rows(deps: Deps, p: Pipeline) {
	return deps.db
		.select()
		.from(statsHourly)
		.where(eq(statsHourly.projectId, p.project.id))
		.orderBy(statsHourly.hour);
}

describe("rollup", () => {
	it("counts received, terminal deliveries, and attempts per dimension", async () => {
		const seedAt = at(T + 10 * 60_000);
		const p = await seedPipeline(seedAt);
		const ok = await seedDelivery(seedAt, p, {
			status: "delivered",
			delivery: { completedAt: T + 20 * 60_000, attemptCount: 2 },
		});
		await attempt(seedAt, ok.deliveryId, 1, T + 11 * 60_000);
		await attempt(seedAt, ok.deliveryId, 2, T + 19 * 60_000);
		await seedDelivery(seedAt, p, {
			status: "dead",
			delivery: { completedAt: T + 25 * 60_000 },
		});
		await seedDelivery(seedAt, p, { status: "retrying" });

		const report = await rollup(at(T + 30 * 60_000), logger);
		expect(report.hours).toEqual([T, T - HOUR_MS, T - 2 * HOUR_MS]);
		expect(report.failed_hours).toEqual([]);
		expect(await rows(seedAt, p)).toEqual([
			{
				hour: T,
				projectId: p.project.id,
				sourceId: p.source.id,
				destinationId: p.destination.id,
				received: 3,
				delivered: 1,
				failedFinal: 0,
				dead: 1,
				attempts: 2,
			},
		]);
	});

	it("counts a replay's outcome but receives the event once", async () => {
		const seedAt = at(T + 5 * 60_000);
		const p = await seedPipeline(seedAt);
		const dead = await seedDelivery(seedAt, p, {
			status: "dead",
			delivery: { completedAt: T + 6 * 60_000 },
		});
		await seedAt.db.insert(deliveries).values({
			id: newId("dlv", T + 7 * 60_000),
			eventId: dead.eventId,
			destinationId: p.destination.id,
			projectId: p.project.id,
			kind: "replay",
			status: "delivered",
			attemptCount: 1,
			completedAt: T + 8 * 60_000,
			createdAt: T + 7 * 60_000,
		});
		await rollup(at(T + 30 * 60_000), logger);
		expect(await rows(seedAt, p)).toMatchObject([
			{ hour: T, received: 1, delivered: 1, dead: 1 },
		]);
	});

	it("is idempotent across runs", async () => {
		const seedAt = at(T + 15 * 60_000);
		const p = await seedPipeline(seedAt);
		await seedDelivery(seedAt, p, {
			status: "delivered",
			delivery: { completedAt: T + 16 * 60_000 },
		});
		await rollup(at(T + 30 * 60_000), logger);
		const first = await rows(seedAt, p);
		await rollup(at(T + 35 * 60_000), logger);
		expect(await rows(seedAt, p)).toEqual(first);
	});

	it("attributes a delivery to the hour it completed in", async () => {
		const seedAt = at(T - HOUR_MS + 50 * 60_000);
		const p = await seedPipeline(seedAt);
		await seedDelivery(seedAt, p, {
			status: "failed_final",
			delivery: { completedAt: T + 2 * 60_000 },
		});
		await rollup(at(T + 30 * 60_000), logger);
		expect(await rows(seedAt, p)).toMatchObject([
			{ hour: T - HOUR_MS, received: 1, failedFinal: 0 },
			{ hour: T, received: 0, failedFinal: 1 },
		]);
	});

	it("keeps going when one hour's batch fails", async () => {
		const seedAt = at(T - HOUR_MS + 5 * 60_000);
		const p = await seedPipeline(seedAt);
		await seedDelivery(seedAt, p, {
			status: "delivered",
			delivery: { completedAt: T - HOUR_MS + 6 * 60_000 },
		});
		// The first batch (hour T) fails; T - 1h still runs.
		const deps = faultyDeps(at(T + 30 * 60_000), {
			d1: [{ match: /delete from "stats_hourly"/i, on: { nth: 1 } }],
		});
		const report = await rollup(deps, logger);
		expect(report.failed_hours).toEqual([T]);
		expect(
			await seedAt.db
				.select()
				.from(statsHourly)
				.where(
					and(
						eq(statsHourly.projectId, p.project.id),
						eq(statsHourly.hour, T - HOUR_MS),
					),
				),
		).toHaveLength(1);
	});
});
