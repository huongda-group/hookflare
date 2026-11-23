import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliveries, settings } from "../src/core/db/schema";
import { HEARTBEAT_KEY, readHeartbeat } from "../src/core/heartbeat";
import worker from "../src/index";
import { ROLLUP_CRON } from "../src/jobs/scheduled";
import { testDeps } from "./helpers/deps";
import { testEnv } from "./helpers/env";
import { fakeBatch, fakeMessage } from "./helpers/queue";
import { seedDelivery, seedPipeline } from "./helpers/seed";

describe("worker entry", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("routes the DLQ batch to the DLQ consumer", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p, { status: "retrying" });
		const msg = fakeMessage({ deliveryId });
		await worker.queue?.(
			fakeBatch("hookflare-deliveries-dlq", [msg]),
			testEnv(),
		);
		const [d] = await deps.db
			.select()
			.from(deliveries)
			.where(eq(deliveries.id, deliveryId));
		expect(d.status).toBe("dead");
		expect(msg.ack).toHaveBeenCalled();
	});

	it("routes any other queue to the delivery consumer", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const deps = testDeps();
		const p = await seedPipeline(deps);
		// A delivered row: the consumer's lease misses, so it acks and skips
		// without calling the backend. The DLQ consumer would mark it dead.
		const { deliveryId } = await seedDelivery(deps, p, {
			status: "delivered",
		});
		const msg = fakeMessage({ deliveryId });
		await worker.queue?.(fakeBatch("hookflare-deliveries", [msg]), testEnv());
		const [d] = await deps.db
			.select()
			.from(deliveries)
			.where(eq(deliveries.id, deliveryId));
		expect(d.status).toBe("delivered");
		expect(msg.ack).toHaveBeenCalled();
	});

	it("dispatches the scheduled cron to its job and records the heartbeat", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const deps = testDeps();
		await deps.db.delete(settings).where(eq(settings.key, HEARTBEAT_KEY));
		const before = Date.now();
		await worker.scheduled?.(
			{ cron: ROLLUP_CRON, scheduledTime: before, noRetry() {} },
			testEnv(),
		);
		const jobs = await readHeartbeat(deps.db);
		expect(jobs?.rollup_at).toBeGreaterThanOrEqual(before);
		expect(jobs?.reconcile_at).toBeUndefined();
		await deps.db.delete(settings).where(eq(settings.key, HEARTBEAT_KEY));
	});
});
