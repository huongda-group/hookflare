import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { settings, statsHourly } from "../../src/core/db/schema";
import { floorHour, HOUR_MS } from "../../src/core/db/stats";
import { createLogger } from "../../src/core/log";
import { BACKFILL_KEY, rollup } from "../../src/jobs/rollup";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const logger = createLogger({ LOG_LEVEL: "error" });
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
});
