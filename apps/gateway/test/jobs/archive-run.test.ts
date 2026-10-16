import {
	DEFAULT_STORAGE_SETTINGS,
	type StorageSettings,
} from "@hookflare/shared";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/core/db/archive";
import {
	archiveBatches,
	settings,
	webhookEvents,
} from "../../src/core/db/schema";
import { createLogger } from "../../src/core/log";
import { batchPrefix, dayOf } from "../../src/jobs/archive/keys";
import {
	EVENT_LINE_COLUMNS,
	EVENT_LINE_EXCLUDED,
} from "../../src/jobs/archive/part";
import { runArchive, type StepFn } from "../../src/jobs/archive/run";
import { isolateArchive, listKeys, seedBatch } from "../helpers/archive";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const logger = createLogger({ LOG_LEVEL: "error" });
const NOW = Date.UTC(2027, 0, 1, 12);
const deps = testDeps({ now: () => NOW });
const plain: StepFn = (_name, fn) => fn();
const big = () => new Uint8Array(70 * 1024).fill(7);
const MiB = 1024 * 1024;

async function setStorage(s: Partial<StorageSettings>) {
	await deps.db.delete(settings).where(eq(settings.key, "storage"));
	await deps.db.insert(settings).values({
		key: "storage",
		valueJson: JSON.stringify({ ...DEFAULT_STORAGE_SETTINGS, ...s }),
		updatedAt: 1,
	});
}

beforeEach(async () => {
	await isolateArchive(deps);
	await deps.db.delete(settings).where(eq(settings.key, "storage"));
});

const exists = async (id: string) =>
	(await deps.db.select().from(webhookEvents).where(eq(webhookEvents.id, id)))
		.length === 1;
const batchesOf = async (day: string) =>
	(await deps.db.select().from(archiveBatches)).filter(
		(b) => b.kind === "events" && b.day === day,
	);

describe("runArchive", () => {
	it("keeps the files of batches it just purged (C1)", async () => {
		await setStorage({
			archive_retention_days: 60,
			audit_retention_days: 365,
			failed_retention_days: 90,
		});
		const p = await seedPipeline(deps);
		const receivedAt = NOW - 100 * DAY_MS;
		const { eventId } = await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt },
		});
		await runArchive(plain, () => deps, "inst-c1", logger);
		expect(await exists(eventId)).toBe(false);
		const [b] = await batchesOf(dayOf(receivedAt));
		expect(b).toMatchObject({ status: "purged", purgedAt: NOW });
		const files = await listKeys(
			deps.payloads,
			batchPrefix("events", b.day, b.id),
		);
		expect(files).toHaveLength(2); // part + manifest

		// A later run inside archive_retention_days keeps them, too.
		await runArchive(plain, () => deps, "inst-c1-b", logger);
		expect(
			await listKeys(deps.payloads, batchPrefix("events", b.day, b.id)),
		).toHaveLength(2);
	});

	it("a crash after the D1 delete still removes the deleted events' payloads only (I5)", async () => {
		const p = await seedPipeline(deps);
		const receivedAt = NOW - 40 * DAY_MS;
		const seeded = [];
		for (let i = 0; i < 3; i++)
			seeded.push(
				await seedDelivery(deps, p, {
					status: "delivered",
					body: big(),
					event: { receivedAt: receivedAt + i },
				}),
			);
		const keys = new Map<string, string>();
		for (const s of seeded) {
			const [row] = await deps.db
				.select({ r2Key: webhookEvents.r2Key })
				.from(webhookEvents)
				.where(eq(webhookEvents.id, s.eventId));
			if (!row?.r2Key) throw new Error("test setup: no r2 key");
			keys.set(s.eventId, row.r2Key);
		}
		const survivor = seeded[0].eventId;
		let crashed = false;
		const crashy: StepFn = async (name, fn) => {
			if (!name.startsWith("purge:") || crashed) return fn();
			crashed = true;
			// A replay clears one mark between the select and the delete step.
			await deps.db
				.update(webhookEvents)
				.set({ archiveBatchId: null, archivePart: null })
				.where(eq(webhookEvents.id, survivor));
			await fn(); // the D1 batch commits...
			return fn(); // ...the step throws, and the retry deletes nothing.
		};
		await runArchive(crashy, () => deps, "inst-i5", logger);
		expect(crashed).toBe(true);
		expect(await exists(survivor)).toBe(true);
		expect(
			await deps.payloads.head(keys.get(survivor) as string),
		).not.toBeNull();
		for (const s of seeded.slice(1)) {
			expect(await exists(s.eventId)).toBe(false);
			expect(
				await deps.payloads.head(keys.get(s.eventId) as string),
			).toBeNull();
		}
	});

	it("archives a day larger than one run over several runs while newer days progress (I7)", async () => {
		const p = await seedPipeline(deps);
		const dayA = NOW - 50 * DAY_MS;
		const dayB = NOW - 45 * DAY_MS;
		const ids = [];
		// 20 MiB each: the 32 MiB byte cap puts one event in each part.
		for (const at of [dayA, dayA + 1, dayA + 2, dayB])
			ids.push(
				(
					await seedDelivery(deps, p, {
						status: "delivered",
						event: { receivedAt: at, sizeBytes: 20 * MiB },
					})
				).eventId,
			);
		// Room for one 2-part events batch per run.
		const limits = { stepBudget: 80, maxPartsPerBatch: 2 };
		await runArchive(plain, () => deps, "inst-i7-1", logger, limits);
		expect((await Promise.all(ids.map(exists))).filter((x) => !x)).toHaveLength(
			2,
		);
		for (let run = 2; run <= 4; run++)
			await runArchive(plain, () => deps, `inst-i7-${run}`, logger, limits);
		for (const id of ids) expect(await exists(id)).toBe(false);
		const a = await batchesOf(dayOf(dayA));
		expect(a.length).toBeGreaterThanOrEqual(2);
		expect(a.every((b) => b.status === "purged")).toBe(true);
		expect((await batchesOf(dayOf(dayB))).map((b) => b.status)).toEqual([
			"purged",
		]);
	});

	it("a resumed batch leaves no event marked past an empty part (Minor 5)", async () => {
		const p = await seedPipeline(deps);
		const receivedAt = NOW - 40 * DAY_MS;
		const day = dayOf(receivedAt);
		const gone = await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt },
		});
		const left = await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: receivedAt + 1 },
		});
		// A crashed run marked two parts but recorded neither; then part 1's
		// only event got a live delivery (replay) and lost its mark.
		const batch = await seedBatch(deps, {
			day,
			workflowInstanceId: "inst-dead",
		});
		await deps.db.run(
			sql`UPDATE webhook_events SET archive_batch_id = ${batch.id}, archive_part = 2 WHERE id = ${left.eventId}`,
		);
		await deps.db.run(
			sql`UPDATE deliveries SET status = 'retrying' WHERE id = ${gone.deliveryId}`,
		);
		await runArchive(plain, () => deps, "inst-m5", logger);
		const [row] = await deps.db
			.select()
			.from(webhookEvents)
			.where(eq(webhookEvents.id, left.eventId));
		// Either archived, or released for the next run; never pinned.
		if (row) expect(row.archiveBatchId).toBeNull();
		await runArchive(plain, () => deps, "inst-m5-b", logger);
		expect(await exists(left.eventId)).toBe(false);
		expect(await exists(gone.eventId)).toBe(true);
	});
});

describe("event line columns (Minor 11)", () => {
	it("covers every webhook_events column except the deliberate exclusions", () => {
		const all = Object.values(getTableColumns(webhookEvents))
			.map((c) => c.name)
			.sort();
		expect([...EVENT_LINE_COLUMNS, ...EVENT_LINE_EXCLUDED].sort()).toEqual(all);
	});
});
