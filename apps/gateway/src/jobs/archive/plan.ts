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
export const MAX_PARTS_PER_BATCH = 200;
const FIXED_STEPS = 10;
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

export function partSteps(kind: "events" | "audit"): number {
	return kind === "events"
		? 1 + 3 * Math.ceil(PART_MAX_EVENTS / PURGE_CHUNK) + 1
		: 2;
}

export function estimateSteps(kind: "events" | "audit", parts: number): number {
	return BATCH_STEPS + parts * partSteps(kind);
}

export function partsFor(items: number, bytes = 0): number {
	return Math.max(
		1,
		Math.ceil(items / PART_MAX_EVENTS),
		Math.ceil(bytes / PART_MAX_RAW_BYTES),
	);
}

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
	const auditBefore =
		Math.floor((now - storage.audit_retention_days * DAY_MS) / DAY_MS) * DAY_MS;
	const auditDays = await deps.db.all<{ dayStart: number; count: number }>(sql`
		SELECT CAST(a.at / ${DAY_MS} AS INTEGER) * ${DAY_MS} AS dayStart, COUNT(*) AS count FROM audit_logs a
		WHERE a.at < ${auditBefore}
		GROUP BY dayStart ORDER BY dayStart`);

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
			const left: { count: number; bytes?: number } | undefined =
				b.kind === "events"
					? dayLeft.get(b.day)
					: auditDays.find((d) => dayOf(d.dayStart) === b.day);
			const more = left ? partsFor(left.count, left.bytes) : 0;
			maxParts = Math.max(built, 1, Math.min(built + more, affordable(b.kind)));
			resumedDays.add(`${b.kind}:${b.day}`);
		}
		const cost = estimateSteps(b.kind, maxParts);
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
		if (resumedDays.has(`events:${day}`)) continue;
		if (!(await create("events", day, partsFor(d.count, d.bytes)))) {
			logger.info("archive.budget_reached", { next_day: day });
			break;
		}
	}

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

async function builtParts(deps: Deps, batchId: string): Promise<number> {
	const [r] = await deps.db.all<{ n: number | null }>(sql`
		SELECT MAX(n) AS n FROM (
			SELECT MAX(part_no) AS n FROM archive_parts WHERE batch_id = ${batchId}
			UNION ALL
			SELECT MAX(archive_part) AS n FROM webhook_events WHERE archive_batch_id = ${batchId}
		)`);
	return r?.n ?? 0;
}
