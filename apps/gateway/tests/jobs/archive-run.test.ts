import {
	DEFAULT_STORAGE_SETTINGS,
	type StorageSettings,
} from "@hookflare/shared";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cutoffsFor, DAY_MS } from "../../src/core/db/archive";
import {
	archiveBatches,
	archiveParts,
	auditLogs,
	settings,
	webhookEvents,
} from "../../src/core/db/schema";
import { createLogger } from "../../src/core/log";
import { batchPrefix, dayOf } from "../../src/jobs/archive/keys";
import {
	buildEventPart,
	EVENT_LINE_COLUMNS,
	EVENT_LINE_EXCLUDED,
} from "../../src/jobs/archive/part";
import { PURGE_CHUNK } from "../../src/jobs/archive/purge";
import { runArchive, type StepFn } from "../../src/jobs/archive/run";
import { verifyBatch } from "../../src/jobs/archive/verify";
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

	it("archives past a part whose events all lack their R2 payload, and keeps them in D1", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await setStorage({ archive_retention_days: null });
			const p = await seedPipeline(deps);
			const receivedAt = NOW - 40 * DAY_MS;
			const day = dayOf(receivedAt);
			// Payload lost (a D1 restore to before a purge), and big enough to
			// fill the whole first part on its own.
			const lost = await seedDelivery(deps, p, {
				status: "delivered",
				body: big(),
				event: { receivedAt },
			});
			const [ev] = await deps.db
				.select({ r2Key: webhookEvents.r2Key })
				.from(webhookEvents)
				.where(eq(webhookEvents.id, lost.eventId));
			await deps.payloads.delete(ev.r2Key as string);
			await deps.db
				.update(webhookEvents)
				.set({ sizeBytes: 32 * MiB })
				.where(eq(webhookEvents.id, lost.eventId));
			const fine = await seedDelivery(deps, p, {
				status: "delivered",
				event: { receivedAt: receivedAt + 1 },
			});

			await runArchive(plain, () => deps, "inst-lost", logger);
			expect(await exists(fine.eventId)).toBe(false);
			expect(await exists(lost.eventId)).toBe(true);
			const [b] = await batchesOf(day);
			expect(b).toMatchObject({ status: "purged", itemCount: 1 });
			const parts = await deps.db
				.select()
				.from(archiveParts)
				.where(eq(archiveParts.batchId, b.id));
			expect(parts.map((x) => [x.firstId, x.itemCount])).toEqual([
				[fine.eventId, 1],
			]);
			expect(
				errorSpy.mock.calls.map((c) => JSON.parse(String(c[0])).msg),
			).toContain("archive.payload_missing");

			// The next run does not pick the lost event up again.
			await runArchive(plain, () => deps, "inst-lost-b", logger);
			expect(await batchesOf(day)).toHaveLength(1);
			expect(await exists(lost.eventId)).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
	});

	/** Records step names, then runs them. */
	function recorder() {
		const names: string[] = [];
		const step: StepFn = (name, fn) => {
			names.push(name);
			return fn();
		};
		return { names, step };
	}

	it("stops after the plan step when the storage setting is corrupt", async () => {
		await deps.db.insert(settings).values({
			key: "storage",
			valueJson: "{not json",
			updatedAt: 1,
		});
		const p = await seedPipeline(deps);
		const { eventId } = await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: NOW - 100 * DAY_MS },
		});
		const { names, step } = recorder();
		expect(await runArchive(step, () => deps, "inst-corrupt", logger)).toEqual({
			batches: 0,
		});
		expect(names).toEqual(["plan"]);
		expect(await exists(eventId)).toBe(true);
	});

	it("purges a resumed verified batch without rebuilding or re-verifying it", async () => {
		const p = await seedPipeline(deps);
		const receivedAt = NOW - 40 * DAY_MS;
		const { eventId } = await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt },
		});
		const batch = await seedBatch(deps, {
			day: dayOf(receivedAt),
			workflowInstanceId: "inst-v",
		});
		const cut = cutoffsFor(DEFAULT_STORAGE_SETTINGS, NOW);
		await buildEventPart(deps, batch.id, 1, cut);
		expect(await verifyBatch(deps, batch.id)).toEqual({ ok: true });

		const { names, step } = recorder();
		await runArchive(step, () => deps, "inst-v", logger);
		expect(names.filter((n) => n.includes(batch.id))).toEqual([
			`parts:${batch.id}`,
			`purge-select:${batch.id}:1:0`,
			`purge:${batch.id}:1:0`,
			`finish:${batch.id}`,
		]);
		expect(await exists(eventId)).toBe(false);
		expect((await batchesOf(dayOf(receivedAt)))[0].status).toBe("purged");
	});

	it("archives and purges audit rows past audit_retention_days", async () => {
		const at = NOW - 400 * DAY_MS;
		await deps.db.insert(auditLogs).values({
			id: "aud_run_1",
			actor: "run@test",
			action: "settings.updated",
			resourceType: "settings",
			resourceId: "x",
			at,
		});
		try {
			const { names, step } = recorder();
			await runArchive(step, () => deps, "inst-audit", logger);
			const [b] = (await deps.db.select().from(archiveBatches)).filter(
				(r) => r.kind === "audit" && r.day === dayOf(at),
			);
			expect(b).toMatchObject({ status: "purged" });
			expect(names).toContain(`part:${b.id}:1`);
			expect(names).toContain(`purge:${b.id}:1`);
			expect(
				await deps.db
					.select()
					.from(auditLogs)
					.where(eq(auditLogs.id, "aud_run_1")),
			).toEqual([]);
			expect(
				await listKeys(deps.payloads, batchPrefix("audit", b.day, b.id)),
			).toHaveLength(2); // part + manifest
		} finally {
			await deps.db.delete(auditLogs).where(eq(auditLogs.id, "aud_run_1"));
		}
	});

	it("logs a failed verify, purges nothing of that batch, and carries on", async () => {
		const p = await seedPipeline(deps);
		const receivedAt = NOW - 40 * DAY_MS;
		const { eventId } = await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt },
		});
		const { names, step: inner } = recorder();
		// The part file is lost between build and verify.
		const step: StepFn = async (name, fn) => {
			if (name.startsWith("verify:")) {
				const parts = await deps.db.select().from(archiveParts);
				for (const part of parts)
					if (part.r2Key) await deps.payloads.delete(part.r2Key);
			}
			return inner(name, fn);
		};
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await runArchive(step, () => deps, "inst-vf", logger);
			const msgs = err.mock.calls.map((c) => JSON.parse(String(c[0])));
			expect(msgs).toContainEqual(
				expect.objectContaining({
					msg: "archive.verify_failed",
					error: "part 1: object missing",
				}),
			);
		} finally {
			err.mockRestore();
		}
		const [b] = await batchesOf(dayOf(receivedAt));
		expect(b.status).toBe("failed");
		expect(names.some((n) => n.startsWith(`parts:${b.id}`))).toBe(false);
		expect(names).not.toContain(`finish:${b.id}`);
		expect(names.at(-1)).toBe("retention");
		expect(await exists(eventId)).toBe(true);
	});

	it("purges a part of more than one chunk, following the select cursor", async () => {
		const p = await seedPipeline(deps);
		const receivedAt = NOW - 40 * DAY_MS;
		// Exactly one full chunk: the second select comes back empty and done.
		await deps.db.run(sql`INSERT INTO webhook_events
			(id, project_id, source_id, received_at, headers_json, content_type, size_bytes, payload_sha256, body_inline)
			WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < ${PURGE_CHUNK})
			SELECT 'evt_bulk_' || printf('%04d', n), ${p.project.id}, ${p.source.id}, ${receivedAt} + n,
				'{}', 'application/json', 2, ${"0".repeat(64)}, X'7B7D' FROM c`);
		await deps.db.run(sql`INSERT INTO deliveries
			(id, event_id, destination_id, project_id, kind, status, attempt_count, enqueued_at, created_at)
			SELECT 'dlv_bulk_' || substr(id, 10), id, ${p.destination.id}, ${p.project.id}, 'initial', 'delivered', 1, ${receivedAt}, ${receivedAt}
			FROM webhook_events WHERE id LIKE 'evt_bulk_%'`);
		const { names, step } = recorder();
		await runArchive(step, () => deps, "inst-bulk", logger);
		const [b] = await batchesOf(dayOf(receivedAt));
		expect(b).toMatchObject({ status: "purged", itemCount: PURGE_CHUNK });
		expect(names.filter((n) => n.startsWith(`purge-select:${b.id}:`))).toEqual([
			`purge-select:${b.id}:1:0`,
			`purge-select:${b.id}:1:1`,
		]);
		expect(names).not.toContain(`purge:${b.id}:1:1`);
		const [left] = await deps.db.all<{ n: number }>(
			sql`SELECT COUNT(*) AS n FROM webhook_events WHERE id LIKE 'evt_bulk_%'`,
		);
		expect(left.n).toBe(0);
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
