import type { StorageSettings } from "@hookflare/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
	type Cutoffs,
	cutoffsFor,
	DAY_MS,
	eligibleDays,
} from "../../core/db/archive";
import { archiveBatches } from "../../core/db/schema";
import { newId } from "../../core/ids";
import type { Logger } from "../../core/log";
import { readSetting, STORAGE_SETTING } from "../../core/settings";
import type { Deps } from "../../deps";
import { dayOf } from "./keys";
import { PART_MAX_EVENTS, PART_MAX_RAW_BYTES } from "./part";
import { PURGE_CHUNK } from "./purge";

export const STEP_BUDGET = 8_000;
/**
 * Most parts one batch builds (1M events). A larger day is split: the batch
 * takes what fits, and the rest of the day goes to a later batch (I7).
 */
export const MAX_PARTS_PER_BATCH = 200;
/** plan + retention, plus head room for the workflow's own bookkeeping. */
const FIXED_STEPS = 10;
/** Per batch: verify, the empty part that ends the build loop, parts list, finish. */
const BATCH_STEPS = 4;

export type PlanLimits = { stepBudget: number; maxPartsPerBatch: number };
export const DEFAULT_LIMITS: PlanLimits = {
	stepBudget: STEP_BUDGET,
	maxPartsPerBatch: MAX_PARTS_PER_BATCH,
};

export type PlannedBatch = {
	id: string;
	kind: "events" | "audit";
	status: "building" | "verified";
	withFiles: boolean;
	/** Upper bound of the build loop; the step budget was reserved for it. */
	maxParts: number;
};
export type Plan =
	| {
			ok: true;
			now: number;
			cut: Cutoffs;
			storage: StorageSettings;
			batches: PlannedBatch[];
	  }
	| { ok: false; reason: "storage_invalid" };

/** Build + purge steps of one part: events purge 3 steps per chunk plus the closing select. */
export function partSteps(kind: "events" | "audit"): number {
	return kind === "events"
		? 1 + 3 * Math.ceil(PART_MAX_EVENTS / PURGE_CHUNK) + 1
		: 2;
}

export function estimateSteps(kind: "events" | "audit", parts: number): number {
	return BATCH_STEPS + parts * partSteps(kind);
}

/** Parts a day needs, by count and by raw bytes (M5-19 caps both). */
export function partsFor(items: number, bytes = 0): number {
	return Math.max(
		1,
		Math.ceil(items / PART_MAX_EVENTS),
		Math.ceil(bytes / PART_MAX_RAW_BYTES),
	);
}

/** Spec §7.4 `plan`. Never guesses settings: a corrupt `storage` row stops the run. */
export async function planRun(
	deps: Deps,
	instanceId: string,
	isRunning: (instanceId: string) => Promise<boolean>,
	logger: Logger,
	limits: PlanLimits = DEFAULT_LIMITS,
): Promise<Plan> {
	const now = deps.now();
	const setting = await readSetting(deps.db, STORAGE_SETTING);
	if (setting.corrupt) {
		logger.error("archive.storage_invalid", {});
		return { ok: false, reason: "storage_invalid" };
	}
	const storage = setting.value;
	const cut = cutoffsFor(storage, now);
	const batches: PlannedBatch[] = [];
	let budget = limits.stepBudget - FIXED_STEPS;
	const affordable = (kind: "events" | "audit") =>
		Math.min(
			limits.maxPartsPerBatch,
			Math.floor((budget - BATCH_STEPS) / partSteps(kind)),
		);

	const days = await eligibleDays(deps.db, cut);
	const dayLeft = new Map(days.map((d) => [dayOf(d.dayStart), d]));
	// Whole UTC days only: a day qualifies once all of it is past the cut-off.
	const auditBefore =
		Math.floor((now - storage.audit_retention_days * DAY_MS) / DAY_MS) * DAY_MS;
	const auditDays = await deps.db.all<{ dayStart: number; count: number }>(sql`
		SELECT CAST(a.at / ${DAY_MS} AS INTEGER) * ${DAY_MS} AS dayStart, COUNT(*) AS count FROM audit_logs a
		WHERE a.at < ${auditBefore}
		GROUP BY dayStart ORDER BY dayStart`);

	// 1. Resume own and abandoned batches.
	const unfinished = await deps.db
		.select()
		.from(archiveBatches)
		.where(inArray(archiveBatches.status, ["building", "verified"]))
		.orderBy(archiveBatches.createdAt);
	const resumedDays = new Set<string>();
	for (const b of unfinished) {
		const foreign = b.workflowInstanceId !== instanceId;
		if (foreign && (await isRunning(b.workflowInstanceId))) continue;
		const built = await builtParts(deps, b.id);
		let maxParts = built;
		if (b.status === "building") {
			// Re-walk the parts already built, then take what fits of the day.
			const left: { count: number; bytes?: number } | undefined =
				b.kind === "events"
					? dayLeft.get(b.day)
					: auditDays.find((d) => dayOf(d.dayStart) === b.day);
			const more = left ? partsFor(left.count, left.bytes) : 0;
			maxParts = Math.max(built, 1, Math.min(built + more, affordable(b.kind)));
			resumedDays.add(`${b.kind}:${b.day}`);
		}
		const cost = estimateSteps(b.kind, maxParts);
		// Budget first: a batch adopted but not run would look freshly owned.
		if (cost > budget) continue;
		if (foreign) {
			const adopted = await deps.db
				.update(archiveBatches)
				.set({ workflowInstanceId: instanceId })
				.where(
					and(
						eq(archiveBatches.id, b.id),
						eq(archiveBatches.workflowInstanceId, b.workflowInstanceId),
					),
				)
				.returning({ id: archiveBatches.id });
			if (adopted.length === 0) continue;
		}
		budget -= cost;
		batches.push({
			id: b.id,
			kind: b.kind,
			status: b.status as PlannedBatch["status"],
			withFiles: b.withFiles,
			maxParts,
		});
	}

	// 2. New batches, oldest day first; each takes the part of its day that fits.
	const create = async (
		kind: "events" | "audit",
		day: string,
		parts: number,
	) => {
		const maxParts = Math.min(parts, affordable(kind));
		if (maxParts < 1) return false;
		budget -= estimateSteps(kind, maxParts);
		const id = newId("arb", now);
		await deps.db.insert(archiveBatches).values({
			id,
			kind,
			day,
			status: "building",
			withFiles: storage.archive_enabled,
			workflowInstanceId: instanceId,
			createdAt: now,
		});
		batches.push({
			id,
			kind,
			status: "building",
			withFiles: storage.archive_enabled,
			maxParts,
		});
		return true;
	};
	for (const d of days) {
		const day = dayOf(d.dayStart);
		// A retried plan step already created (or resumed) this day's batch.
		if (resumedDays.has(`events:${day}`)) continue;
		if (!(await create("events", day, partsFor(d.count, d.bytes)))) {
			// Audit days still get what is left of the budget.
			logger.info("archive.budget_reached", { next_day: day });
			break;
		}
	}

	// 3. Audit days past audit_retention_days. Rows never change, so a day with
	// a building or verified batch is handled; a failed batch's day is retried,
	// and rows a capped batch left behind are picked up after it is purged.
	const taken = new Set(
		(
			await deps.db
				.select({ day: archiveBatches.day })
				.from(archiveBatches)
				.where(
					and(
						eq(archiveBatches.kind, "audit"),
						inArray(archiveBatches.status, ["building", "verified"]),
					),
				)
		).map((r) => r.day),
	);
	for (const d of auditDays) {
		const day = dayOf(d.dayStart);
		if (taken.has(day)) continue;
		if (!(await create("audit", day, partsFor(d.count)))) break;
	}
	return { ok: true, now, cut, storage, batches };
}

/** Highest part number the batch has built or marked; the build loop re-walks them. */
async function builtParts(deps: Deps, batchId: string): Promise<number> {
	const [r] = await deps.db.all<{ n: number | null }>(sql`
		SELECT MAX(n) AS n FROM (
			SELECT MAX(part_no) AS n FROM archive_parts WHERE batch_id = ${batchId}
			UNION ALL
			SELECT MAX(archive_part) AS n FROM webhook_events WHERE archive_batch_id = ${batchId}
		)`);
	return r?.n ?? 0;
}
