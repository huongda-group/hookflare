import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { settings, statsHourly } from "../../src/core/db/schema";
import { floorHour, HOUR_MS } from "../../src/core/db/stats";
import { createLogger } from "../../src/core/log";
import type { Deps } from "../../src/deps";
import { BACKFILL_KEY, rollup } from "../../src/jobs/rollup";
import { testDeps } from "../helpers/deps";
import { faultyDeps } from "../helpers/faults";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const logger = createLogger({ LOG_LEVEL: "error" });

const setCursor = (deps: Deps, valueJson: string) =>
	deps.db
		.insert(settings)
		.values({ key: BACKFILL_KEY, valueJson, updatedAt: 0 })
		.onConflictDoUpdate({ target: settings.key, set: { valueJson } });
const T = floorHour(1_900_000_000_000);

describe("rollup backfill", () => {
	it("moves back 6 hours per run and stops after the oldest event", async () => {
		const old = { ...testDeps(), now: () => T - 20 * HOUR_MS + 60_000 };
		const p = await seedPipeline(old);
		await seedDelivery(old, p);
		const run = () => rollup({ ...testDeps(), now: () => T + 60_000 }, logger);

		expect((await run()).backfill_before).toBe(T - 8 * HOUR_MS);
		expect((await run()).backfill_before).toBe(T - 14 * HOUR_MS);
		expect((await run()).backfill_before).toBe("done");

		const cursor = await old.db
			.select()
			.from(settings)
			.where(eq(settings.key, BACKFILL_KEY))
			.get();
		expect(cursor?.valueJson).toBe('"done"');
		const stats = await old.db
			.select()
			.from(statsHourly)
			.where(eq(statsHourly.projectId, p.project.id));
		expect(stats).toMatchObject([{ hour: T - 20 * HOUR_MS, received: 1 }]);
		// A fourth run does no backfill work.
		expect((await run()).backfill_before).toBe("done");
	});

	it("restarts from the recent window when the cursor holds an unexpected value", async () => {
		const old = { ...testDeps(), now: () => T - 20 * HOUR_MS + 60_000 };
		await seedDelivery(old, await seedPipeline(old));
		const deps = { ...testDeps(), now: () => T + 60_000 };
		await setCursor(deps, JSON.stringify({ before: 1 }));
		const report = await rollup(deps, logger);
		// Recent hours are T, T-1h, T-2h; a restarted backfill starts below them.
		expect(report.hours.slice(3)[0]).toBe(T - 3 * HOUR_MS);
		expect(report.backfill_before).toBe(T - 8 * HOUR_MS);
	});

	it("stops at the oldest event's hour before using the whole per-run budget", async () => {
		const old = { ...testDeps(), now: () => T - 20 * HOUR_MS + 60_000 };
		const p = await seedPipeline(old);
		await seedDelivery(old, p);
		// Two hours of backfill remain: T-19h and T-20h.
		const deps = { ...testDeps(), now: () => T - 16 * HOUR_MS + 60_000 };
		await setCursor(deps, JSON.stringify(T - 18 * HOUR_MS));
		const report = await rollup(deps, logger);
		expect(report.hours.slice(3)).toEqual([T - 19 * HOUR_MS, T - 20 * HOUR_MS]);
		expect(report.backfill_before).toBe("done");
	});

	it("keeps the cursor at the failed hour so the backfill never skips it", async () => {
		const old = { ...testDeps(), now: () => T - 20 * HOUR_MS + 60_000 };
		const p = await seedPipeline(old);
		await seedDelivery(old, p);
		const base = { ...testDeps(), now: () => T + 60_000 };
		await setCursor(base, JSON.stringify(T - 10 * HOUR_MS));
		// The 3 recent hours succeed; the second backfill hour fails.
		const deps = faultyDeps(base, {
			d1: [{ match: /delete from "stats_hourly"/i, on: { nth: 5 } }],
		});
		const report = await rollup(deps, logger);
		expect(report.failed_hours).toEqual([T - 12 * HOUR_MS]);
		expect(report.backfill_before).toBe(T - 11 * HOUR_MS);
		const cursor = await base.db
			.select()
			.from(settings)
			.where(eq(settings.key, BACKFILL_KEY))
			.get();
		expect(cursor?.valueJson).toBe(JSON.stringify(T - 11 * HOUR_MS));
	});

	it("restarts the backfill from a corrupt cursor instead of failing", async () => {
		const deps = { ...testDeps(), now: () => T + 60_000 };
		await deps.db
			.insert(settings)
			.values({ key: BACKFILL_KEY, valueJson: "{not json", updatedAt: 0 })
			.onConflictDoUpdate({
				target: settings.key,
				set: { valueJson: "{not json" },
			});
		const report = await rollup(deps, logger);
		expect(report.failed_hours).toEqual([]);
		expect(report.backfill_before).not.toBeNull();
		expect(report.rows[T]).toBeTypeOf("number");
	});
});
