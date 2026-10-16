import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
	countMarked,
	cutoffsFor,
	DAY_MS,
	eligibleSql,
	markPart,
} from "../../src/core/db/archive";
import type { DeliveryStatus } from "../../src/core/db/schema";
import type { Deps } from "../../src/deps";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const NOW = Date.UTC(2027, 5, 1);
const cut = cutoffsFor(
	{ hot_retention_days: 30, failed_retention_days: 90 },
	NOW,
);
const deps = testDeps();

async function isEligible(d: Deps, eventId: string) {
	const rows = await d.db.all<{ id: string }>(
		sql`SELECT e.id FROM webhook_events e WHERE e.id = ${eventId} AND ${eligibleSql(cut, "e")}`,
	);
	return rows.length === 1;
}

/** Seeds one event received `ageDays` ago with one delivery per status. */
async function eventWith(ageDays: number, statuses: string[]) {
	const p = await seedPipeline(deps);
	const receivedAt = NOW - ageDays * DAY_MS;
	const first = await seedDelivery(deps, p, {
		status: statuses[0] as DeliveryStatus,
		event: { receivedAt },
	});
	for (const s of statuses.slice(1)) {
		await seedDelivery(deps, p, {
			status: s as DeliveryStatus,
			eventId: first.eventId,
		});
	}
	return first.eventId;
}

describe("eligibility (spec §7.3)", () => {
	it.each([
		[31, ["delivered"], true],
		[29, ["delivered"], false],
		[31, ["delivered", "retrying"], false],
		[31, ["dead"], false],
		[91, ["dead"], true],
		[91, ["failed_final", "delivered"], true],
		[89, ["failed_final"], false],
		[365, ["paused"], false],
		[365, ["in_flight"], false],
	])("age %i days with %j → %s", async (age, statuses, expected) => {
		expect(await isEligible(deps, await eventWith(age, statuses))).toBe(
			expected,
		);
	});

	it("treats an event with no deliveries as delivered", async () => {
		const p = await seedPipeline(deps);
		const { eventId, deliveryId } = await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: NOW - 31 * DAY_MS },
		});
		await deps.db.run(sql`DELETE FROM deliveries WHERE id = ${deliveryId}`);
		expect(await isEligible(deps, eventId)).toBe(true);
	});
});

describe("markPart (M5-17)", () => {
	beforeEach(async () => {
		// Other files' old events must not leak into this day's marks.
		await deps.db.run(
			sql`UPDATE webhook_events SET archive_batch_id = 'other' WHERE archive_batch_id IS NULL`,
		);
	});

	it("marks unmarked eligible events of one day up to the caps, at least one", async () => {
		const day = Date.UTC(2027, 3, 1);
		const p = await seedPipeline(deps);
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const { eventId } = await seedDelivery(deps, p, {
				status: "delivered",
				event: { receivedAt: day + i * 1000, sizeBytes: 10 },
			});
			ids.push(eventId);
		}
		const base = { dayStart: day, cut, maxEvents: 5000 };
		expect(
			await markPart(deps.db, {
				...base,
				batchId: "arb_a",
				partNo: 1,
				maxRawBytes: 25,
			}),
		).toBe(2);
		expect(
			await markPart(deps.db, {
				...base,
				batchId: "arb_a",
				partNo: 2,
				maxRawBytes: 5,
			}),
		).toBe(1); // first row always fits
		expect(
			await markPart(deps.db, {
				...base,
				batchId: "arb_b",
				partNo: 1,
				maxRawBytes: 25,
			}),
		).toBe(0); // nothing left unmarked
		expect(await countMarked(deps.db, "arb_a", 1)).toBe(2);
	});

	it("never marks the same event for two concurrent batches", async () => {
		const day = Date.UTC(2027, 3, 2);
		const p = await seedPipeline(deps);
		for (let i = 0; i < 20; i++)
			await seedDelivery(deps, p, {
				status: "delivered",
				event: { receivedAt: day + i },
			});
		const args = {
			dayStart: day,
			cut,
			maxEvents: 5000,
			maxRawBytes: 1 << 30,
			partNo: 1,
		};
		const [a, b] = await Promise.all([
			markPart(deps.db, { ...args, batchId: "arb_x" }),
			markPart(deps.db, { ...args, batchId: "arb_y" }),
		]);
		expect(a + b).toBe(20);
	});
});
