import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
	acquireLease,
	recordLeasedAttempt,
} from "../../src/core/db/deliveries";
import { destinations } from "../../src/core/db/schema";
import type { AttemptOutcome } from "../../src/delivery/classify";
import type { Deps } from "../../src/deps";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const failed: AttemptOutcome = {
	status: "retrying",
	httpStatus: 500,
	errorKind: "http_5xx",
	error: "HTTP 500",
	delaySeconds: 30,
};
const ok: AttemptOutcome = {
	status: "delivered",
	httpStatus: 200,
	errorKind: null,
	error: null,
	delaySeconds: null,
};

async function counter(deps: Deps, id: string) {
	const [d] = await deps.db
		.select()
		.from(destinations)
		.where(eq(destinations.id, id));
	return d.consecutiveFailures;
}

async function attempt(
	deps: Deps,
	deliveryId: string,
	outcome: AttemptOutcome,
	attemptNo: number,
	leaseOverride?: number,
) {
	const leaseUntil = Date.now() + 60_000 + attemptNo;
	await acquireLease(deps, deliveryId, leaseUntil);
	return recordLeasedAttempt(deps, deliveryId, {
		attemptNo,
		startedAt: Date.now(),
		durationMs: 5,
		outcome,
		snippet: null,
		leaseUntil: leaseOverride ?? leaseUntil,
	});
}

describe("destinations.consecutive_failures (M5-12)", () => {
	it("increments on each failure and resets on delivered", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p, { status: "queued" });
		await attempt(deps, deliveryId, failed, 1);
		await attempt(deps, deliveryId, failed, 2);
		expect(await counter(deps, p.destination.id)).toBe(2);
		await attempt(deps, deliveryId, ok, 3);
		expect(await counter(deps, p.destination.id)).toBe(0);
	});

	it("changes nothing when the lease fence fails", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p, { status: "queued" });
		const recorded = await attempt(deps, deliveryId, failed, 1, 123);
		expect(recorded).toBe(false);
		expect(await counter(deps, p.destination.id)).toBe(0);
	});
});
