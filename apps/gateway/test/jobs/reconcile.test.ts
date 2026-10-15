import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	deliveries,
	deliveryAttempts,
	webhookEvents,
} from "../../src/core/db/schema";
import { newId } from "../../src/core/ids";
import type { Deps } from "../../src/deps";
import { reconcile } from "../../src/jobs/reconcile";
import { type RecordingQueue, recordingQueue, testDeps } from "../helpers/deps";
import { faultyDeps } from "../helpers/faults";
import { type Pipeline, seedDelivery, seedPipeline } from "../helpers/seed";

const T0 = 1_800_000_000_000;
const MIN = 60_000;

function setup(overrides: Partial<Deps> = {}) {
	let t = T0;
	const deps = testDeps({
		now: () => t,
		queue: recordingQueue(),
		...overrides,
	});
	return {
		deps,
		queue: deps.queue as RecordingQueue,
		setNow: (v: number) => (t = v),
	};
}

async function status(deps: Deps, id: string) {
	const [d] = await deps.db
		.select()
		.from(deliveries)
		.where(eq(deliveries.id, id));
	return d;
}

/** Many deliveries for one event; the batch keeps us under D1's bound-parameter limit. */
async function seedMany(
	deps: Deps,
	p: Pipeline,
	n: number,
	delivery: Partial<typeof deliveries.$inferInsert>,
) {
	const { eventId } = await seedDelivery(deps, p, { status: "delivered" });
	const rows = Array.from({ length: n }, (_, i) => ({
		id: newId("dlv", T0 - 3_600_000 + i),
		eventId,
		destinationId: p.destination.id,
		projectId: p.project.id,
		kind: "initial" as const,
		status: "pending" as const,
		attemptCount: 0,
		createdAt: T0 - 3_600_000,
		...delivery,
	}));
	await deps.db.batch(
		rows.map((r) => deps.db.insert(deliveries).values(r)) as never,
	);
}

describe("reconcile", () => {
	beforeEach(async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		// One miniflare D1 is shared by every test in this file and reconcile
		// selects globally by status/time, so wipe rows (pipelines accumulate
		// harmlessly; only deliveries/events can match a later rule).
		const deps = testDeps();
		await deps.db.delete(deliveryAttempts);
		await deps.db.delete(deliveries);
		await deps.db.delete(webhookEvents);
	});

	it("(a) enqueues pending deliveries older than 60 s that were never enqueued", async () => {
		const { deps, queue } = setup();
		const p = await seedPipeline(deps);
		const old = await seedDelivery(deps, p, {
			delivery: {
				status: "pending",
				enqueuedAt: null,
				createdAt: T0 - 2 * MIN,
			},
		});
		const fresh = await seedDelivery(deps, p, {
			delivery: { status: "pending", enqueuedAt: null, createdAt: T0 - 10_000 },
		});
		const report = await reconcile(deps);
		expect(report.pending).toBe(1);
		expect(queue.sent).toEqual([{ deliveryId: old.deliveryId }]);
		expect(await status(deps, old.deliveryId)).toMatchObject({
			status: "queued",
			enqueuedAt: T0,
		});
		expect((await status(deps, fresh.deliveryId)).status).toBe("pending");
	});

	it("(b) turns leases expired for 5 min into retrying without counting an attempt", async () => {
		const { deps, queue } = setup();
		const p = await seedPipeline(deps);
		const stuck = await seedDelivery(deps, p, {
			delivery: {
				status: "in_flight",
				leaseUntil: T0 - 6 * MIN,
				attemptCount: 2,
			},
		});
		const recent = await seedDelivery(deps, p, {
			delivery: { status: "in_flight", leaseUntil: T0 - MIN },
		});
		await reconcile(deps);
		expect(await status(deps, stuck.deliveryId)).toMatchObject({
			status: "retrying",
			attemptCount: 2,
			leaseUntil: null,
			nextAttemptAt: T0,
			enqueuedAt: T0,
		});
		expect((await status(deps, recent.deliveryId)).status).toBe("in_flight");
		expect(queue.sent).toEqual([{ deliveryId: stuck.deliveryId }]);
	});

	it("(c) re-enqueues overdue retries and never moves next_attempt_at", async () => {
		const { deps, queue } = setup();
		const p = await seedPipeline(deps);
		const overdue = await seedDelivery(deps, p, {
			delivery: {
				status: "retrying",
				nextAttemptAt: T0 - 20 * MIN,
				enqueuedAt: T0 - 60 * MIN,
			},
		});
		const future = await seedDelivery(deps, p, {
			delivery: {
				status: "retrying",
				nextAttemptAt: T0 + 60 * MIN,
				enqueuedAt: T0 - 60 * MIN,
			},
		});
		const justSent = await seedDelivery(deps, p, {
			delivery: {
				status: "retrying",
				nextAttemptAt: T0 - 20 * MIN,
				enqueuedAt: T0 - MIN,
			},
		});
		await reconcile(deps);
		expect(queue.sent).toEqual([{ deliveryId: overdue.deliveryId }]);
		expect(await status(deps, overdue.deliveryId)).toMatchObject({
			enqueuedAt: T0,
			nextAttemptAt: T0 - 20 * MIN,
		});
		expect((await status(deps, future.deliveryId)).nextAttemptAt).toBe(
			T0 + 60 * MIN,
		);
		expect((await status(deps, justSent.deliveryId)).enqueuedAt).toBe(T0 - MIN);
	});

	it("(d) re-enqueues deliveries queued for over 30 min, and the cooldown stops a repeat", async () => {
		const { deps, queue, setNow } = setup();
		const p = await seedPipeline(deps);
		const stale = await seedDelivery(deps, p, {
			delivery: { status: "queued", enqueuedAt: T0 - 31 * MIN },
		});
		await reconcile(deps);
		setNow(T0 + MIN);
		await reconcile(deps);
		expect(queue.sent).toEqual([{ deliveryId: stale.deliveryId }]);
	});

	it("(e)/(e′) releases paused deliveries of active destinations and fails disabled ones", async () => {
		const { deps, queue } = setup();
		const active = await seedPipeline(deps);
		const disabled = await seedPipeline(deps, {
			destination: { status: "disabled" },
		});
		const stillPaused = await seedPipeline(deps, {
			destination: { status: "paused" },
		});
		const a = await seedDelivery(deps, active, { status: "paused" });
		const d = await seedDelivery(deps, disabled, { status: "paused" });
		const s = await seedDelivery(deps, stillPaused, { status: "paused" });
		const report = await reconcile(deps);
		expect(report).toMatchObject({ resumed_paused: 1, failed_paused: 1 });
		expect(await status(deps, a.deliveryId)).toMatchObject({
			status: "pending",
			enqueuedAt: null,
		});
		expect(await status(deps, d.deliveryId)).toMatchObject({
			status: "failed_final",
			lastError: "destination_disabled",
			completedAt: T0,
		});
		expect((await status(deps, s.deliveryId)).status).toBe("paused");
		expect(queue.sent).toHaveLength(0);
	});

	it("handles at most 500 rows per run", async () => {
		const { deps, queue } = setup();
		const p = await seedPipeline(deps);
		await seedMany(deps, p, 300, { status: "pending", enqueuedAt: null });
		await seedMany(deps, p, 300, {
			status: "queued",
			enqueuedAt: T0 - 31 * MIN,
		});
		const report = await reconcile(deps);
		expect(report).toMatchObject({ pending: 300, stale_queued: 200 });
		expect(queue.sent).toHaveLength(500);
	});

	it("re-sends next run when the update after a send fails", async () => {
		const { deps: base } = setup();
		const p = await seedPipeline(base);
		const { deliveryId } = await seedDelivery(base, p, {
			delivery: { status: "queued", enqueuedAt: T0 - 31 * MIN },
		});
		const deps = faultyDeps(base, {
			d1: [{ match: /^update "deliveries"/, on: { nth: 1 } }],
		});
		// drizzle wraps driver errors in DrizzleQueryError; the fault surfaces as `cause` (as in test/faults.test.ts).
		const err = await reconcile(deps).then(
			() => null,
			(e: unknown) => e as Error & { cause?: unknown },
		);
		expect(err).toBeInstanceOf(Error);
		expect(String(err?.cause)).toMatch(/D1_ERROR/);
		await reconcile(deps);
		expect((base.queue as RecordingQueue).sent).toEqual([
			{ deliveryId },
			{ deliveryId },
		]);
		expect((await status(base, deliveryId)).enqueuedAt).toBe(T0);
	});

	it("does not mark anything when the send fails", async () => {
		const { deps: base } = setup();
		const p = await seedPipeline(base);
		const { deliveryId } = await seedDelivery(base, p, {
			delivery: {
				status: "pending",
				enqueuedAt: null,
				createdAt: T0 - 2 * MIN,
			},
		});
		const deps = faultyDeps(base, { queue: [{ match: /^sendBatch$/ }] });
		expect((await reconcile(deps)).send_failed).toBe(1);
		expect((await status(base, deliveryId)).status).toBe("pending");
	});
});
