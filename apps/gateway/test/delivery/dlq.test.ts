import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliveries } from "../../src/core/db/schema";
import { DLQ_QUEUE, handleDlqBatch } from "../../src/delivery/dlq";
import { testDeps } from "../helpers/deps";
import { faultyDeps } from "../helpers/faults";
import { fakeBatch, fakeMessage } from "../helpers/queue";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const T0 = 1_800_000_000_000;

describe("DLQ consumer", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("marks claimable deliveries dead and leaves live leases, paused, and terminal ones", async () => {
		const deps = testDeps({ now: () => T0 });
		const p = await seedPipeline(deps);
		const seeded = await Promise.all(
			(
				[
					"queued",
					"retrying",
					"in_flight",
					"in_flight",
					"paused",
					"delivered",
					"failed_final",
				] as const
			).map((status, i) =>
				seedDelivery(deps, p, {
					status,
					// [2] lease expired, [3] lease still live.
					delivery: {
						leaseUntil:
							status === "in_flight" ? (i === 2 ? T0 - 1 : T0 + 1) : null,
					},
				}),
			),
		);
		const msgs = seeded.map((s) => fakeMessage({ deliveryId: s.deliveryId }));
		await handleDlqBatch(fakeBatch(DLQ_QUEUE, msgs), deps);
		const statuses = await Promise.all(
			seeded.map(async (s) => {
				const [d] = await deps.db
					.select()
					.from(deliveries)
					.where(eq(deliveries.id, s.deliveryId));
				return d.status;
			}),
		);
		expect(statuses).toEqual([
			"dead",
			"dead",
			"dead",
			"in_flight",
			"paused",
			"delivered",
			"failed_final",
		]);
		const [dead] = await deps.db
			.select()
			.from(deliveries)
			.where(eq(deliveries.id, seeded[2].deliveryId));
		expect(dead).toMatchObject({
			lastError: "dlq: infra retries exhausted",
			leaseUntil: null,
			completedAt: T0,
		});
		expect(msgs.every((m) => m.ack.mock.calls.length === 1)).toBe(true);
	});

	it("acks malformed messages and retries on D1 errors", async () => {
		const base = testDeps();
		const p = await seedPipeline(base);
		const { deliveryId } = await seedDelivery(base, p);
		const deps = faultyDeps(base, { d1: [{ match: /update "deliveries"/ }] });
		const bad = fakeMessage("garbage");
		const failing = fakeMessage({ deliveryId });
		await handleDlqBatch(fakeBatch(DLQ_QUEUE, [bad, failing]), deps);
		expect(bad.ack).toHaveBeenCalled();
		expect(failing.retry).toHaveBeenCalled();
	});
});
