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
import { PART_MAX_EVENTS } from "./part";
import { PURGE_CHUNK } from "./purge";

export const STEP_BUDGET = 8_000;
/** plan + retention, plus head room for the workflow's own bookkeeping. */
const FIXED_STEPS = 10;

export type PlannedBatch = {
	id: string;
	kind: "events" | "audit";
	status: "building" | "verified";
	withFiles: boolean;
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

/** Parts (+1 empty), verify, purge D1 + R2 per chunk and per part, finish. */
export function estimateSteps(kind: "events" | "audit", items: number): number {
	const parts = Math.ceil(items / PART_MAX_EVENTS);
	const purge =
		kind === "events" ? 2 * (Math.ceil(items / PURGE_CHUNK) + parts) : parts;
	return parts + 1 + 1 + purge + 1;
}

/** Spec §7.4 `plan`. Never guesses settings: a corrupt `storage` row stops the run. */
export async function planRun(
	deps: Deps,
	instanceId: string,
	isRunning: (instanceId: string) => Promise<boolean>,
	logger: Logger,
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
	let budget = STEP_BUDGET - FIXED_STEPS;

	// 1. Resume own and abandoned batches.
	const unfinished = await deps.db
		.select()
		.from(archiveBatches)
		.where(inArray(archiveBatches.status, ["building", "verified"]))
		.orderBy(archiveBatches.createdAt);
	for (const b of unfinished) {
		if (b.workflowInstanceId !== instanceId) {
			if (await isRunning(b.workflowInstanceId)) continue;
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
		const cost = estimateSteps(b.kind, Math.max(b.itemCount, PART_MAX_EVENTS));
		if (cost > budget) break;
		budget -= cost;
		batches.push({
			id: b.id,
			kind: b.kind,
			status: b.status as PlannedBatch["status"],
			withFiles: b.withFiles,
		});
	}

	// 2. New event batches, oldest day first.
	const create = async (
		kind: "events" | "audit",
		day: string,
		items: number,
	) => {
		const cost = estimateSteps(kind, items);
		if (cost > budget) return false;
		budget -= cost;
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
		});
		return true;
	};
	for (const d of await eligibleDays(deps.db, cut)) {
		if (!(await create("events", dayOf(d.dayStart), d.count))) {
			logger.info("archive.budget_reached", { next_day: dayOf(d.dayStart) });
			return { ok: true, now, cut, storage, batches };
		}
	}

	// 3. Audit days past audit_retention_days, once per day: rows never change,
	// so a day with any non-expired, non-purged audit batch is already handled.
	const auditDays = await deps.db.all<{ dayStart: number; count: number }>(sql`
		SELECT CAST(a.at / ${DAY_MS} AS INTEGER) * ${DAY_MS} AS dayStart, COUNT(*) AS count FROM audit_logs a
		WHERE a.at < ${now - storage.audit_retention_days * DAY_MS}
		GROUP BY dayStart ORDER BY dayStart`);
	const taken = new Set(
		(
			await deps.db
				.select({ day: archiveBatches.day })
				.from(archiveBatches)
				.where(
					and(
						eq(archiveBatches.kind, "audit"),
						inArray(archiveBatches.status, ["building", "verified", "failed"]),
					),
				)
		).map((r) => r.day),
	);
	for (const d of auditDays) {
		const day = dayOf(d.dayStart);
		if (taken.has(day)) continue;
		if (!(await create("audit", day, d.count))) break;
	}
	return { ok: true, now, cut, storage, batches };
}
