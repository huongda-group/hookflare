import { DEFAULT_STORAGE_SETTINGS } from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { isArchiveRunning } from "../../src/core/archive-run";
import { DAY_MS } from "../../src/core/db/archive";
import {
	archiveBatches,
	archiveParts,
	auditLogs,
	settings,
	webhookEvents,
} from "../../src/core/db/schema";
import { createLogger } from "../../src/core/log";
import { buildEventPart } from "../../src/jobs/archive/part";
import { planRun } from "../../src/jobs/archive/plan";
import { expireArchives } from "../../src/jobs/archive/retention";
import { verifyBatch } from "../../src/jobs/archive/verify";
import { isolateArchive, listKeys, seedBatch } from "../helpers/archive";
import { fakeArchive, testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const logger = createLogger({ LOG_LEVEL: "error" });
const NOW = Date.UTC(2027, 0, 1, 12);
const deps = testDeps({ now: () => NOW });
const never = async () => false;

beforeEach(async () => {
	await isolateArchive(deps);
	await deps.db.delete(settings).where(eq(settings.key, "storage"));
});

const batchRow = async (id: string) =>
	(
		await deps.db.select().from(archiveBatches).where(eq(archiveBatches.id, id))
	)[0];

async function insertAudit(id: string, at: number) {
	await deps.db.insert(auditLogs).values({
		id,
		actorEmail: "plan@test",
		action: "settings.updated",
		resourceType: "settings",
		resourceId: "x",
		at,
	});
}

describe("retention is measured from purged_at (C1)", () => {
	it("keeps a just-purged batch of an old day and expires one purged long ago", async () => {
		const fresh = await seedBatch(deps, {
			status: "purged",
			day: "2026-01-01",
			purgedAt: NOW - DAY_MS,
		});
		const stale = await seedBatch(deps, {
			status: "purged",
			day: "2026-10-01",
			purgedAt: NOW - 61 * DAY_MS,
		});
		for (const b of [fresh, stale])
			await deps.payloads.put(
				`archive/${b.day.replaceAll("-", "/")}/${b.id}/part-0001.ndjson.gz`,
				"x",
			);
		const storage = { ...DEFAULT_STORAGE_SETTINGS, archive_retention_days: 60 };
		expect(await expireArchives(deps, storage, NOW)).toBe(1);
		expect((await batchRow(fresh.id)).status).toBe("purged");
		expect(
			await listKeys(deps.payloads, `archive/2026/01/01/${fresh.id}/`),
		).toHaveLength(1);
		expect((await batchRow(stale.id)).status).toBe("expired");
		expect(
			await listKeys(deps.payloads, `archive/2026/10/01/${stale.id}/`),
		).toEqual([]);
	});
});

describe("planRun follow-ups", () => {
	it("a retried plan step does not create a second batch for the same day (Minor 6)", async () => {
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: NOW - 40 * DAY_MS },
		});
		const first = await planRun(deps, "inst-retry", never, logger);
		const second = await planRun(deps, "inst-retry", never, logger);
		if (!first.ok || !second.ok) throw new Error("expected plans");
		const rows = await deps.db.select().from(archiveBatches);
		expect(rows.filter((r) => r.kind === "events")).toHaveLength(1);
		expect(second.batches.map((b) => b.id)).toEqual(
			first.batches.map((b) => b.id),
		);
	});

	it("plans an audit day only once the whole UTC day is past the cut-off (Minor 7)", async () => {
		const cutoff = NOW - 365 * DAY_MS; // 12:00 UTC
		const dayStart = Math.floor(cutoff / DAY_MS) * DAY_MS;
		// Older than the cut-off, but the rest of its UTC day is not.
		await insertAudit("aud_partial_day", dayStart + 1_000);
		try {
			const plan = await planRun(deps, "inst-audit-day", never, logger);
			if (!plan.ok) throw new Error("expected a plan");
			const day = new Date(dayStart).toISOString().slice(0, 10);
			expect(
				(await deps.db.select().from(archiveBatches)).filter(
					(r) => r.kind === "audit" && r.day === day,
				),
			).toEqual([]);
		} finally {
			await deps.db
				.delete(auditLogs)
				.where(eq(auditLogs.id, "aud_partial_day"));
		}
	});

	it("retries an audit day whose only batch failed (I6)", async () => {
		await insertAudit("aud_failed_day", Date.UTC(2025, 5, 1));
		try {
			await seedBatch(deps, {
				kind: "audit",
				day: "2025-06-01",
				status: "failed",
			});
			const plan = await planRun(deps, "inst-audit-retry", never, logger);
			if (!plan.ok) throw new Error("expected a plan");
			expect(
				(await deps.db.select().from(archiveBatches)).filter(
					(r) => r.day === "2025-06-01" && r.status === "building",
				),
			).toHaveLength(1);
		} finally {
			await deps.db.delete(auditLogs).where(eq(auditLogs.id, "aud_failed_day"));
		}
	});
});

describe("failed verify releases the batch (I6)", () => {
	it("clears the marks, re-archives the day, and retention removes the failed files", async () => {
		const p = await seedPipeline(deps);
		const { eventId } = await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: NOW - 40 * DAY_MS },
		});
		const plan = await planRun(deps, "inst-fail", never, logger);
		if (!plan.ok) throw new Error("expected a plan");
		const b = plan.batches.find((x) => x.kind === "events");
		if (!b) throw new Error("expected an events batch");
		await buildEventPart(deps, b.id, 1, plan.cut);
		await deps.db
			.update(archiveParts)
			.set({ sha256: "0".repeat(64) })
			.where(eq(archiveParts.batchId, b.id));
		expect((await verifyBatch(deps, b.id)).ok).toBe(false);
		const [ev] = await deps.db
			.select()
			.from(webhookEvents)
			.where(eq(webhookEvents.id, eventId));
		expect(ev).toMatchObject({ archiveBatchId: null, archivePart: null });

		const prefix = `archive/2026/11/22/${b.id}/`;
		expect(await listKeys(deps.payloads, prefix)).toHaveLength(1);
		await expireArchives(deps, DEFAULT_STORAGE_SETTINGS, NOW);
		expect(await listKeys(deps.payloads, prefix)).toEqual([]);
		expect((await batchRow(b.id)).status).toBe("failed");

		const next = await planRun(deps, "inst-fail-2", never, logger);
		if (!next.ok) throw new Error("expected a plan");
		const retry = next.batches.find((x) => x.kind === "events");
		if (!retry) throw new Error("expected the day to be planned again");
		expect(retry.id).not.toBe(b.id);
		await buildEventPart(deps, retry.id, 1, next.cut);
		expect(await verifyBatch(deps, retry.id)).toEqual({ ok: true });
	});
});

describe("isArchiveRunning (Minor 8)", () => {
	it("treats only not-found as not running", async () => {
		const missing = testDeps({ archive: fakeArchive("missing") });
		expect(await isArchiveRunning(missing, "gone")).toBe(false);
		const broken = testDeps({
			archive: {
				get: async () => {
					throw new Error("internal error");
				},
			} as unknown as Workflow,
		});
		expect(await isArchiveRunning(broken, "x")).toBe(true);
	});
});
