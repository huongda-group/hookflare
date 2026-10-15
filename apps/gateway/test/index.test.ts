import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { deliveries } from "../src/core/db/schema";
import worker from "../src/index";
import { testDeps } from "./helpers/deps";
import { testEnv } from "./helpers/env";
import { fakeBatch, fakeMessage } from "./helpers/queue";
import { seedDelivery, seedPipeline } from "./helpers/seed";

describe("worker entry", () => {
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
});
