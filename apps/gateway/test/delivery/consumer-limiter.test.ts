import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliveries, deliveryAttempts } from "../../src/core/db/schema";
import { createLogger } from "../../src/core/log";
import { clearSsrfCache } from "../../src/core/ssrf";
import {
	LEASE_GRACE_MS,
	limitedDelaySeconds,
	processDelivery,
} from "../../src/delivery/consumer";
import type { Deps } from "../../src/deps";
import { recordingQueue, testDeps } from "../helpers/deps";
import { fakeLimiter } from "../helpers/limiter";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const logger = createLogger({ LOG_LEVEL: "error" });

async function row(deps: Deps, id: string) {
	const [d] = await deps.db
		.select()
		.from(deliveries)
		.where(eq(deliveries.id, id));
	const attempts = await deps.db
		.select()
		.from(deliveryAttempts)
		.where(eq(deliveryAttempts.deliveryId, id));
	return { d, attempts };
}

async function seedLimited(
	deps: Deps,
	limits: { maxInFlight?: number | null; rateLimitPerS?: number | null },
) {
	const p = await seedPipeline(deps, {
		destination: {
			maxInFlight: limits.maxInFlight ?? null,
			rateLimitPerS: limits.rateLimitPerS ?? null,
		},
	});
	const { deliveryId } = await seedDelivery(deps, p, { status: "queued" });
	return { p, deliveryId };
}

describe("limitedDelaySeconds", () => {
	it("adds 0–3 s of jitter and clamps to [1, 30]", () => {
		expect(limitedDelaySeconds(200, () => 0)).toBe(1);
		expect(limitedDelaySeconds(5_000, () => 0.999)).toBe(8);
		expect(limitedDelaySeconds(30_000, () => 0.999)).toBe(30);
		expect(limitedDelaySeconds(0, () => 0)).toBe(1);
	});
});

describe("processDelivery with a limiter (spec §5.3)", () => {
	beforeEach(() => {
		clearSsrfCache();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("never calls the limiter when both limits are null (M5-6)", async () => {
		const fake = fakeLimiter();
		const deps = testDeps({ limiter: fake.limiter });
		const { deliveryId } = await seedLimited(deps, {});
		expect(await processDelivery(deps, deliveryId, logger)).toEqual({
			action: "ack",
		});
		expect(fake.acquires).toHaveLength(0);
		expect((await row(deps, deliveryId)).d.status).toBe("delivered");
	});

	it("passes the limits and the lease length, then releases after recording", async () => {
		const fake = fakeLimiter();
		const deps = testDeps({ limiter: fake.limiter });
		const { p, deliveryId } = await seedLimited(deps, {
			maxInFlight: 3,
			rateLimitPerS: 7,
		});
		await processDelivery(deps, deliveryId, logger);
		expect(fake.destinations).toEqual([p.destination.id]);
		expect(fake.acquires).toEqual([
			{ maxInFlight: 3, ratePerS: 7, leaseMs: 10_000 + LEASE_GRACE_MS },
		]);
		expect(fake.releases).toEqual(["slot-1"]);
		expect((await row(deps, deliveryId)).d.status).toBe("delivered");
	});

	it("on rejection: acks, sends one delayed message, and counts no attempt (exit criterion 3)", async () => {
		const fake = fakeLimiter([
			{ ok: false, reason: "in_flight", retryAfterMs: 12_000 },
		]);
		const queue = recordingQueue();
		const deps = testDeps({ limiter: fake.limiter, queue });
		const { deliveryId } = await seedLimited(deps, { maxInFlight: 1 });
		expect(await processDelivery(deps, deliveryId, logger)).toEqual({
			action: "ack",
		});
		expect(queue.sent).toEqual([{ deliveryId }]);
		expect(queue.delays[0]).toBeGreaterThanOrEqual(12);
		expect(queue.delays[0]).toBeLessThanOrEqual(15);
		const { d, attempts } = await row(deps, deliveryId);
		expect(d.status).toBe("queued");
		expect(d.attemptCount).toBe(0);
		expect(d.leaseUntil).toBeNull();
		expect(attempts).toHaveLength(0);
		expect(deps.fetch).not.toHaveBeenCalled();
		expect(fake.releases).toHaveLength(0);
	});

	it("falls back to msg.retry when the delayed send fails", async () => {
		const fake = fakeLimiter([
			{ ok: false, reason: "rate", retryAfterMs: 400 },
		]);
		const deps = testDeps({
			limiter: fake.limiter,
			queue: recordingQueue({ fail: true }),
		});
		const { deliveryId } = await seedLimited(deps, { rateLimitPerS: 1 });
		const r = await processDelivery(deps, deliveryId, logger);
		expect(r.action).toBe("retry");
		if (r.action === "retry") expect(r.delaySeconds).toBeGreaterThanOrEqual(1);
		expect((await row(deps, deliveryId)).d.attemptCount).toBe(0);
	});

	it("treats a limiter error as an infra retry (M5-7)", async () => {
		const deps = testDeps({ limiter: fakeLimiter("throw").limiter });
		const { deliveryId } = await seedLimited(deps, { maxInFlight: 1 });
		const r = await processDelivery(deps, deliveryId, logger);
		expect(r.action).toBe("retry");
		expect((await row(deps, deliveryId)).d.attemptCount).toBe(0);
	});

	it("treats a limiter that does not answer within 2 s as an infra retry", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const deps = testDeps({ limiter: fakeLimiter("hang").limiter });
			const { deliveryId } = await seedLimited(deps, { maxInFlight: 1 });
			const pending = processDelivery(deps, deliveryId, logger);
			await vi.advanceTimersByTimeAsync(2_001);
			expect((await pending).action).toBe("retry");
		} finally {
			vi.useRealTimers();
		}
	});

	it("releases the slot when the lease is not acquired", async () => {
		const releases: string[] = [];
		const deps = testDeps();
		const { deliveryId } = await seedLimited(deps, { maxInFlight: 1 });
		deps.limiter = () => ({
			async acquire() {
				// Another worker leases the delivery while we wait for a slot.
				await deps.db
					.update(deliveries)
					.set({ status: "in_flight", leaseUntil: Date.now() + 60_000 })
					.where(eq(deliveries.id, deliveryId));
				return { ok: true, slotId: "slot-x" };
			},
			async release(id) {
				releases.push(id);
			},
		});
		expect(await processDelivery(deps, deliveryId, logger)).toEqual({
			action: "ack",
		});
		expect(releases).toEqual(["slot-x"]);
	});

	it("releases the slot when the record step throws", async () => {
		const fake = fakeLimiter();
		const deps = testDeps({ limiter: fake.limiter });
		const { deliveryId } = await seedLimited(deps, { maxInFlight: 1 });
		const realBatch = deps.db.batch.bind(deps.db);
		let calls = 0;
		deps.db.batch = ((stmts: unknown) => {
			calls++;
			// acquireLease does not batch; the first batch is recordLeasedAttempt.
			if (calls === 1) return Promise.reject(new Error("D1_ERROR"));
			return realBatch(stmts as never);
		}) as typeof deps.db.batch;
		const r = await processDelivery(deps, deliveryId, logger);
		expect(r.action).toBe("retry");
		expect(fake.releases).toEqual(["slot-1"]);
	});

	it("logs and ignores a failing release", async () => {
		const fake = fakeLimiter(undefined, { releaseFails: true });
		const deps = testDeps({ limiter: fake.limiter });
		const { deliveryId } = await seedLimited(deps, { maxInFlight: 1 });
		expect(await processDelivery(deps, deliveryId, logger)).toEqual({
			action: "ack",
		});
		expect((await row(deps, deliveryId)).d.status).toBe("delivered");
	});
});
