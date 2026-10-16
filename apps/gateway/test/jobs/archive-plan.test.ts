import { DEFAULT_STORAGE_SETTINGS } from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/core/db/archive";
import { archiveBatches, settings } from "../../src/core/db/schema";
import { createLogger } from "../../src/core/log";
import {
	estimateSteps,
	planRun,
	STEP_BUDGET,
} from "../../src/jobs/archive/plan";
import { expireArchives } from "../../src/jobs/archive/retention";
import { isolateArchive, listKeys, seedBatch } from "../helpers/archive";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const logger = createLogger({ LOG_LEVEL: "error" });
const NOW = Date.UTC(2027, 0, 1);
const deps = testDeps({ now: () => NOW });
const never = async () => false;

beforeEach(async () => {
	await isolateArchive(deps);
	await deps.db.delete(settings).where(eq(settings.key, "storage"));
});

describe("planRun", () => {
	it("creates one events batch per day with unmarked eligible events", async () => {
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: NOW - 40 * DAY_MS },
		});
		await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: NOW - 40 * DAY_MS + 5 },
		});
		await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: NOW - 41 * DAY_MS },
		});
		await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: NOW - 10 * DAY_MS },
		});
		const plan = await planRun(deps, "inst-1", never, logger);
		if (!plan.ok) throw new Error("expected a plan");
		const events = plan.batches.filter((b) => b.kind === "events");
		expect(events).toHaveLength(2);
		const rows = await deps.db.select().from(archiveBatches);
		expect(
			rows
				.filter((r) => r.kind === "events")
				.map((r) => r.day)
				.sort(),
		).toEqual(["2026-11-21", "2026-11-22"]);
		expect(
			rows.every(
				(r) => r.workflowInstanceId === "inst-1" && r.status === "building",
			),
		).toBe(true);
	});

	it("resumes its own and abandoned batches, but not ones a live instance owns", async () => {
		const mine = await seedBatch(deps, { workflowInstanceId: "inst-2" });
		const abandoned = await seedBatch(deps, {
			workflowInstanceId: "dead-inst",
			status: "verified",
		});
		const live = await seedBatch(deps, { workflowInstanceId: "live-inst" });
		const plan = await planRun(
			deps,
			"inst-2",
			async (id) => id === "live-inst",
			logger,
		);
		if (!plan.ok) throw new Error("expected a plan");
		const ids = plan.batches.map((b) => b.id);
		expect(ids).toContain(mine.id);
		expect(ids).toContain(abandoned.id);
		expect(ids).not.toContain(live.id);
		const [adopted] = await deps.db
			.select()
			.from(archiveBatches)
			.where(eq(archiveBatches.id, abandoned.id));
		expect(adopted.workflowInstanceId).toBe("inst-2");
	});

	it("does nothing on a corrupt storage row (Review Focus 5)", async () => {
		await deps.db.insert(settings).values({
			key: "storage",
			valueJson: '{"hot_retention_days":"x"}',
			updatedAt: 1,
		});
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: NOW - 400 * DAY_MS },
		});
		expect(await planRun(deps, "inst-3", never, logger)).toEqual({
			ok: false,
			reason: "storage_invalid",
		});
		expect(await deps.db.select().from(archiveBatches)).toEqual([]);
	});

	it("stops planning new days at the step budget (M5-22)", async () => {
		expect(estimateSteps("events", 0)).toBeGreaterThan(0);
		const perDay = estimateSteps("events", 500_000);
		expect(Math.floor(STEP_BUDGET / perDay)).toBeLessThan(5);
	});

	it("plans audit days older than audit_retention_days once", async () => {
		const { auditLogs } = await import("../../src/core/db/schema");
		await deps.db.insert(auditLogs).values({
			id: "aud_plan_1",
			actorEmail: "plan@test",
			action: "settings.updated",
			resourceType: "settings",
			resourceId: "x",
			at: NOW - 400 * DAY_MS,
		});
		const first = await planRun(deps, "inst-4", never, logger);
		const second = await planRun(
			deps,
			"inst-5",
			async (id) => id === "inst-4",
			logger,
		);
		if (!first.ok || !second.ok) throw new Error("expected plans");
		expect(
			first.batches.filter((b) => b.kind === "audit").length,
		).toBeGreaterThanOrEqual(1);
		expect(second.batches.filter((b) => b.kind === "audit")).toEqual([]);
	});
});

describe("expireArchives", () => {
	it("deletes files of purged batches older than archive_retention_days", async () => {
		const old = await seedBatch(deps, { status: "purged", day: "2026-01-01" });
		const recent = await seedBatch(deps, {
			status: "purged",
			day: "2026-12-01",
		});
		await deps.payloads.put(
			`archive/2026/01/01/${old.id}/part-0001.ndjson.gz`,
			"x",
		);
		await deps.payloads.put(
			`archive/2026/12/01/${recent.id}/part-0001.ndjson.gz`,
			"x",
		);
		const storage = {
			...DEFAULT_STORAGE_SETTINGS,
			archive_retention_days: 180,
		};
		expect(await expireArchives(deps, storage, NOW)).toBe(1);
		expect(
			await listKeys(deps.payloads, `archive/2026/01/01/${old.id}/`),
		).toEqual([]);
		expect(
			await listKeys(deps.payloads, `archive/2026/12/01/${recent.id}/`),
		).toHaveLength(1);
		expect(
			(
				await deps.db
					.select()
					.from(archiveBatches)
					.where(eq(archiveBatches.id, old.id))
			)[0].status,
		).toBe("expired");
		expect(await expireArchives(deps, storage, NOW)).toBe(0);
		expect(await expireArchives(deps, DEFAULT_STORAGE_SETTINGS, NOW)).toBe(0); // null = forever
	});
});
