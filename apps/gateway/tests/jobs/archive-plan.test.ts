import { DEFAULT_STORAGE_SETTINGS } from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/core/db/archive";
import { archiveBatches, settings } from "../../src/core/db/schema";
import { createLogger } from "../../src/core/log";
import {
	estimateSteps,
	MAX_PARTS_PER_BATCH,
	partsFor,
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
		// A 500k-event day is 100 parts; a batch is capped so the budget always
		// fits at least one full-size batch.
		expect(partsFor(500_000)).toBe(100);
		expect(partsFor(10, 100 * 1024 * 1024)).toBe(4); // bytes cap counts too
		const perDay = estimateSteps("events", partsFor(500_000));
		expect(Math.floor(STEP_BUDGET / perDay)).toBeLessThan(5);
		expect(estimateSteps("events", MAX_PARTS_PER_BATCH)).toBeLessThan(
			STEP_BUDGET - 10,
		);
	});

	it("plans audit days older than audit_retention_days once", async () => {
		const { auditLogs } = await import("../../src/core/db/schema");
		await deps.db.insert(auditLogs).values({
			id: "aud_plan_1",
			actor: "plan@test",
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

	it("resumes its own building audit batch instead of opening a second one for the day", async () => {
		const { auditLogs } = await import("../../src/core/db/schema");
		const at = NOW - 400 * DAY_MS;
		await deps.db.insert(auditLogs).values({
			id: "aud_plan_resume",
			actor: "plan@test",
			action: "settings.updated",
			resourceType: "settings",
			resourceId: "x",
			at,
		});
		try {
			const day = new Date(at).toISOString().slice(0, 10);
			const own = await seedBatch(deps, {
				kind: "audit",
				day,
				workflowInstanceId: "inst-ra",
			});
			const plan = await planRun(deps, "inst-ra", never, logger);
			if (!plan.ok) throw new Error("expected a plan");
			const audit = plan.batches.filter((b) => b.kind === "audit");
			expect(audit.filter((b) => b.id === own.id)).toEqual([
				expect.objectContaining({ status: "building", maxParts: 1 }),
			]);
			const rows = (await deps.db.select().from(archiveBatches)).filter(
				(r) => r.kind === "audit" && r.day === day,
			);
			expect(rows.map((r) => r.id)).toEqual([own.id]);
		} finally {
			await deps.db
				.delete(auditLogs)
				.where(eq(auditLogs.id, "aud_plan_resume"));
		}
	});

	it("skips an abandoned batch another instance adopts first", async () => {
		const abandoned = await seedBatch(deps, { workflowInstanceId: "dead-x" });
		const plan = await planRun(
			deps,
			"inst-slow",
			async (id) => {
				// A concurrent plan adopts it between the liveness check and ours.
				await deps.db
					.update(archiveBatches)
					.set({ workflowInstanceId: "inst-fast" })
					.where(eq(archiveBatches.id, abandoned.id));
				return id !== "dead-x";
			},
			logger,
		);
		if (!plan.ok) throw new Error("expected a plan");
		expect(plan.batches.map((b) => b.id)).not.toContain(abandoned.id);
		const [row] = await deps.db
			.select()
			.from(archiveBatches)
			.where(eq(archiveBatches.id, abandoned.id));
		expect(row.workflowInstanceId).toBe("inst-fast");
	});

	it("opens no audit batch when the budget cannot afford a single part", async () => {
		const { auditLogs } = await import("../../src/core/db/schema");
		for (const [i, id] of ["aud_poor_1", "aud_poor_2"].entries())
			await deps.db.insert(auditLogs).values({
				id,
				actor: "plan@test",
				action: "settings.updated",
				resourceType: "settings",
				resourceId: "x",
				at: NOW - (400 + i) * DAY_MS,
			});
		try {
			// 15 - 10 fixed = 5 steps: below one batch (4) plus one audit part (2).
			const plan = await planRun(deps, "inst-poor", never, logger, {
				stepBudget: 15,
				maxPartsPerBatch: MAX_PARTS_PER_BATCH,
			});
			if (!plan.ok) throw new Error("expected a plan");
			expect(plan.batches).toEqual([]);
			expect(await deps.db.select().from(archiveBatches)).toEqual([]);
		} finally {
			await deps.db.delete(auditLogs).where(eq(auditLogs.actor, "plan@test"));
		}
	});
});

describe("expireArchives", () => {
	it("deletes files of purged batches older than archive_retention_days", async () => {
		const old = await seedBatch(deps, {
			status: "purged",
			day: "2026-01-01",
			purgedAt: NOW - 200 * DAY_MS,
		});
		const recent = await seedBatch(deps, {
			status: "purged",
			day: "2026-12-01",
			purgedAt: NOW - 10 * DAY_MS,
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

	it("removes a failed batch's files across list pages and keeps its row", async () => {
		const failed = await seedBatch(deps, {
			status: "failed",
			day: "2026-02-03",
			withFiles: true,
		});
		const empty = await seedBatch(deps, {
			status: "failed",
			day: "2026-02-04",
			withFiles: true,
		});
		const prefix = `archive/2026/02/03/${failed.id}/`;
		for (const k of ["part-0001.ndjson.gz", "part-0002.ndjson.gz", "x"])
			await deps.payloads.put(`${prefix}${k}`, "x");
		const paged = {
			...deps,
			payloads: new Proxy(deps.payloads, {
				get(target, prop) {
					if (prop === "list")
						return (o: R2ListOptions) => target.list({ ...o, limit: 1 });
					const v = Reflect.get(target, prop);
					return typeof v === "function" ? v.bind(target) : v;
				},
			}),
		};
		expect(await expireArchives(paged, DEFAULT_STORAGE_SETTINGS, NOW)).toBe(0);
		expect(await listKeys(deps.payloads, prefix)).toEqual([]);
		const rows = await deps.db.select().from(archiveBatches);
		for (const id of [failed.id, empty.id])
			expect(rows.find((r) => r.id === id)).toMatchObject({
				status: "failed",
				withFiles: false,
			});
	});
});
