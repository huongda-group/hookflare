import { isArchiveRunning } from "../../core/archive-run";
import type { Logger } from "../../core/log";
import type { Deps } from "../../deps";
import { buildAuditPart, buildEventPart } from "./part";
import { DEFAULT_LIMITS, type PlanLimits, planRun } from "./plan";
import {
	deleteGonePayloads,
	deletePurgeChunk,
	finishBatch,
	listParts,
	purgeAuditPart,
	selectPurgeChunk,
} from "./purge";
import { expireArchives } from "./retention";
import { verifyBatch } from "./verify";

/** One durable, retried step: `step.do` in the Workflow, a plain call in tests. */
export type StepFn = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Spec §7.4. Orchestration only: every step is a plain function over Deps.
 * Code outside a step must be deterministic (Workflows replays it), so time,
 * settings, and loop cursors come from persisted step results.
 */
export async function runArchive(
	step: StepFn,
	deps: () => Deps,
	instanceId: string,
	logger: Logger,
	limits: PlanLimits = DEFAULT_LIMITS,
): Promise<{ batches: number }> {
	const plan = await step("plan", () =>
		planRun(
			deps(),
			instanceId,
			(id) => isArchiveRunning(deps(), id),
			logger,
			limits,
		),
	);
	if (!plan.ok) return { batches: 0 };

	for (const b of plan.batches) {
		if (b.status === "building") {
			for (let n = 1; n <= b.maxParts; n++) {
				const r = await step(`part:${b.id}:${n}`, () =>
					b.kind === "events"
						? buildEventPart(deps(), b.id, n, plan.cut, logger)
						: buildAuditPart(deps(), b.id, n),
				);
				if (r.itemCount === 0) break;
			}
			const v = await step(`verify:${b.id}`, () => verifyBatch(deps(), b.id));
			if (!v.ok) {
				logger.error("archive.verify_failed", {
					batch_id: b.id,
					error: v.error,
				});
				continue;
			}
		}
		// Every part verify covered, including parts an earlier attempt built
		// past the point where this build loop stopped (Minor 5).
		const parts = await step(`parts:${b.id}`, () => listParts(deps(), b.id));
		for (const n of parts) {
			if (b.kind === "audit") {
				await step(`purge:${b.id}:${n}`, () => purgeAuditPart(deps(), b.id, n));
				continue;
			}
			let after = "";
			for (let k = 0; ; k++) {
				const sel = await step(`purge-select:${b.id}:${n}:${k}`, () =>
					selectPurgeChunk(deps(), b.id, n, plan.cut, after),
				);
				if (sel.rows.length) {
					const ids = sel.rows.map((r) => r.id);
					await step(`purge:${b.id}:${n}:${k}`, () =>
						deletePurgeChunk(deps(), b.id, n, plan.cut, ids),
					);
					if (sel.rows.some((r) => r.r2Key))
						await step(`purge-r2:${b.id}:${n}:${k}`, () =>
							deleteGonePayloads(deps(), sel.rows),
						);
				}
				if (sel.done) break;
				after = sel.rows[sel.rows.length - 1].id;
			}
		}
		await step(`finish:${b.id}`, () => finishBatch(deps(), b.id));
	}
	await step("retention", () => expireArchives(deps(), plan.storage, plan.now));
	return { batches: plan.batches.length };
}
