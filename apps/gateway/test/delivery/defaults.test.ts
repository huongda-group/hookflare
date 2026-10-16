import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliveries, settings } from "../../src/core/db/schema";
import { createLogger } from "../../src/core/log";
import {
	clearRetryDefaultsCache,
	loadRetryDefaults,
	RETRY_DEFAULTS_KEY,
	SETTINGS_CACHE_TTL_MS,
	upsertRetryDefaults,
} from "../../src/core/settings";
import { processDelivery } from "../../src/delivery/consumer";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const logger = createLogger({ LOG_LEVEL: "error" });

beforeEach(async () => {
	clearRetryDefaultsCache();
	await testDeps()
		.db.delete(settings)
		.where(eq(settings.key, RETRY_DEFAULTS_KEY));
});

async function statusOf(deps: ReturnType<typeof testDeps>, id: string) {
	const row = await deps.db
		.select({ status: deliveries.status })
		.from(deliveries)
		.where(eq(deliveries.id, id))
		.get();
	return row?.status;
}

describe("consumer and retry defaults", () => {
	it("applies new defaults after the cache TTL", async () => {
		let now = Date.now();
		const deps = testDeps({
			now: () => now,
			fetch: vi.fn(
				async () => new Response("down", { status: 503 }),
			) as unknown as typeof fetch,
		});
		const p = await seedPipeline(deps);
		await loadRetryDefaults(deps); // caches DEFAULT_POLICY (20 attempts)
		await upsertRetryDefaults(
			deps.db,
			{
				timeout_ms: 5000,
				max_attempts: 1,
				backoff_base_s: 10,
				backoff_max_s: 600,
			},
			now,
		);

		const first = await seedDelivery(deps, p);
		await processDelivery(deps, first.deliveryId, logger);
		expect(await statusOf(deps, first.deliveryId)).toBe("retrying");

		now += SETTINGS_CACHE_TTL_MS;
		const second = await seedDelivery(deps, p);
		await processDelivery(deps, second.deliveryId, logger);
		// A 503 is retryable, so an exhausted budget lands on "dead"
		// (consumer.test.ts asserts the same for destination budgets).
		expect(await statusOf(deps, second.deliveryId)).toBe("dead");
	});

	it("lets the destination's own max_attempts win", async () => {
		const deps = testDeps({
			fetch: vi.fn(
				async () => new Response("down", { status: 503 }),
			) as unknown as typeof fetch,
		});
		await upsertRetryDefaults(
			deps.db,
			{
				timeout_ms: 5000,
				max_attempts: 1,
				backoff_base_s: 10,
				backoff_max_s: 600,
			},
			deps.now(),
		);
		const p = await seedPipeline(deps, { destination: { maxAttempts: 5 } });
		const d = await seedDelivery(deps, p);
		await processDelivery(deps, d.deliveryId, logger);
		expect(await statusOf(deps, d.deliveryId)).toBe("retrying");
	});
});
