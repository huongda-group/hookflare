import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
	acquireLease,
	finishWithoutAttempt,
	holdDelivery,
	isClaimable,
	recordLeasedAttempt,
} from "../../../src/core/db/deliveries";
import { deliveries, deliveryAttempts } from "../../../src/core/db/schema";
import type { AttemptOutcome } from "../../../src/delivery/classify";
import type { Deps } from "../../../src/deps";
import { testDeps } from "../../helpers/deps";
import { seedDelivery, seedPipeline } from "../../helpers/seed";

const T0 = 1_800_000_000_000;
const clock = () => testDeps({ now: () => T0 });

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

const retrying: AttemptOutcome = {
	status: "retrying",
	errorKind: "http_5xx",
	httpStatus: 503,
	error: "HTTP 503",
	delaySeconds: 30,
};

describe("lease", () => {
	it("leases a queued delivery and returns its attempt count", async () => {
		const deps = clock();
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p, {
			delivery: { attemptCount: 2 },
		});
		expect(await acquireLease(deps, deliveryId, T0 + 40_000)).toBe(2);
		const { d } = await row(deps, deliveryId);
		expect(d).toMatchObject({
			status: "in_flight",
			leaseUntil: T0 + 40_000,
			nextAttemptAt: null,
		});
	});

	it("refuses a live lease and re-acquires an expired one", async () => {
		const deps = clock();
		const p = await seedPipeline(deps);
		const live = await seedDelivery(deps, p, {
			delivery: { status: "in_flight", leaseUntil: T0 + 1 },
		});
		const expired = await seedDelivery(deps, p, {
			delivery: { status: "in_flight", leaseUntil: T0 - 1 },
		});
		expect(await acquireLease(deps, live.deliveryId, T0 + 40_000)).toBeNull();
		expect(await acquireLease(deps, expired.deliveryId, T0 + 40_000)).toBe(0);
	});

	it.each(["delivered", "failed_final", "dead", "paused"] as const)(
		"never leases a %s delivery",
		async (status) => {
			const deps = clock();
			const p = await seedPipeline(deps);
			const { deliveryId } = await seedDelivery(deps, p, { status });
			expect(await acquireLease(deps, deliveryId, T0 + 1)).toBeNull();
		},
	);

	it("isClaimable matches the SQL predicate", async () => {
		const base = { leaseUntil: null } as const;
		expect(isClaimable({ ...base, status: "retrying" } as never, T0)).toBe(
			true,
		);
		expect(
			isClaimable({ status: "in_flight", leaseUntil: T0 - 1 } as never, T0),
		).toBe(true);
		expect(
			isClaimable({ status: "in_flight", leaseUntil: T0 } as never, T0),
		).toBe(false);
		expect(isClaimable({ ...base, status: "paused" } as never, T0)).toBe(false);
	});
});

describe("recordLeasedAttempt", () => {
	it("records a retrying attempt with next_attempt_at and enqueued_at", async () => {
		const deps = clock();
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p);
		const L = T0 + 40_000;
		await acquireLease(deps, deliveryId, L);
		expect(
			await recordLeasedAttempt(deps, deliveryId, {
				attemptNo: 1,
				startedAt: T0,
				durationMs: 5,
				outcome: retrying,
				snippet: "busy",
				leaseUntil: L,
			}),
		).toBe(true);
		const { d, attempts } = await row(deps, deliveryId);
		expect(d).toMatchObject({
			status: "retrying",
			attemptCount: 1,
			leaseUntil: null,
			nextAttemptAt: T0 + 30_000,
			enqueuedAt: T0,
			completedAt: null,
			lastHttpStatus: 503,
			lastError: "HTTP 503",
		});
		expect(attempts).toEqual([
			expect.objectContaining({
				attemptNo: 1,
				httpStatus: 503,
				responseSnippet: "busy",
			}),
		]);
	});

	it("sets completed_at for terminal outcomes", async () => {
		const deps = clock();
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p);
		await acquireLease(deps, deliveryId, T0 + 1);
		await recordLeasedAttempt(deps, deliveryId, {
			attemptNo: 1,
			startedAt: T0,
			durationMs: 1,
			outcome: {
				status: "delivered",
				errorKind: null,
				httpStatus: 200,
				error: null,
				delaySeconds: null,
			},
			snippet: null,
			leaseUntil: T0 + 1,
		});
		expect((await row(deps, deliveryId)).d).toMatchObject({
			status: "delivered",
			completedAt: T0,
			nextAttemptAt: null,
		});
	});

	it("writes nothing when the lease was taken over (fencing)", async () => {
		const deps = clock();
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p);
		await acquireLease(deps, deliveryId, T0 + 1);
		// Another worker re-leased after expiry.
		await deps.db
			.update(deliveries)
			.set({ leaseUntil: T0 + 99 })
			.where(eq(deliveries.id, deliveryId));
		expect(
			await recordLeasedAttempt(deps, deliveryId, {
				attemptNo: 1,
				startedAt: T0,
				durationMs: 1,
				outcome: retrying,
				snippet: null,
				leaseUntil: T0 + 1,
			}),
		).toBe(false);
		const { d, attempts } = await row(deps, deliveryId);
		expect(attempts).toHaveLength(0);
		expect(d).toMatchObject({
			status: "in_flight",
			leaseUntil: T0 + 99,
			attemptCount: 0,
		});
	});
});

describe("no-attempt endings", () => {
	it("holds a claimable delivery as paused and never touches a terminal one", async () => {
		const deps = clock();
		const p = await seedPipeline(deps);
		const q = await seedDelivery(deps, p, {
			delivery: { status: "retrying", nextAttemptAt: T0 },
		});
		const done = await seedDelivery(deps, p, { status: "delivered" });
		await holdDelivery(deps, q.deliveryId);
		await holdDelivery(deps, done.deliveryId);
		expect((await row(deps, q.deliveryId)).d).toMatchObject({
			status: "paused",
			nextAttemptAt: null,
		});
		expect((await row(deps, done.deliveryId)).d.status).toBe("delivered");
	});

	it("finishWithoutAttempt also ends an expired in_flight delivery", async () => {
		const deps = clock();
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p, {
			delivery: { status: "in_flight", leaseUntil: T0 - 1 },
		});
		await finishWithoutAttempt(deps, deliveryId, "payload_missing");
		expect((await row(deps, deliveryId)).d).toMatchObject({
			status: "failed_final",
			lastError: "payload_missing",
			leaseUntil: null,
			completedAt: T0,
		});
	});
});
