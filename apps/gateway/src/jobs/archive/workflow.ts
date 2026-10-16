import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { type ArchiveParams, isArchiveRunning } from "../../core/archive-run";
import { archiveParts } from "../../core/db/schema";
import { createLogger } from "../../core/log";
import { createDeps, type Deps } from "../../deps";
import { buildAuditPart, buildEventPart } from "./part";
import { planRun } from "./plan";
import {
	deletePayloadObjects,
	finishBatch,
	purgeAuditPart,
	purgeEventChunk,
} from "./purge";
import { expireArchives } from "./retention";
import { verifyBatch } from "./verify";

const STEP = {
	retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
	timeout: "10 minutes",
} as const;

/**
 * Spec §7.4. Orchestration only: every step is a plain function over Deps.
 * Code outside step.do() must be deterministic (Workflows replays it), so
 * time and settings come from the persisted `plan` result.
 */
export class ArchiveWorkflow extends WorkflowEntrypoint<
	Deps["env"],
	ArchiveParams
> {
	async run(event: WorkflowEvent<ArchiveParams>, step: WorkflowStep) {
		const deps = () => createDeps(this.env);
		const logger = createLogger(this.env, {
			workflow: "archive",
			instance_id: event.instanceId,
		});
		const plan = await step.do("plan", STEP, () =>
			planRun(
				deps(),
				event.instanceId,
				(id) => isArchiveRunning(deps(), id),
				logger,
			),
		);
		if (!plan.ok) return { batches: 0 };

		for (const b of plan.batches) {
			const parts: number[] = [];
			if (b.status === "building") {
				for (let n = 1; ; n++) {
					const r = await step.do(`part:${b.id}:${n}`, STEP, () =>
						b.kind === "events"
							? buildEventPart(deps(), b.id, n, plan.cut)
							: buildAuditPart(deps(), b.id, n),
					);
					if (r.itemCount === 0) break;
					parts.push(n);
				}
				const v = await step.do(`verify:${b.id}`, STEP, () =>
					verifyBatch(deps(), b.id),
				);
				if (!v.ok) continue;
			} else {
				// Resumed verified batch: purge every part it has.
				const known = await step.do(`parts:${b.id}`, STEP, async () => {
					const rows = await deps()
						.db.select({ n: archiveParts.partNo })
						.from(archiveParts)
						.where(eq(archiveParts.batchId, b.id));
					return rows.map((r) => r.n);
				});
				parts.push(...known);
			}
			for (const n of parts) {
				if (b.kind === "audit") {
					await step.do(`purge:${b.id}:${n}`, STEP, () =>
						purgeAuditPart(deps(), b.id, n),
					);
					continue;
				}
				for (let k = 0; ; k++) {
					const chunk = await step.do(`purge:${b.id}:${n}:${k}`, STEP, () =>
						purgeEventChunk(deps(), b.id, n, plan.cut),
					);
					if (chunk.r2Keys.length) {
						await step.do(`purge-r2:${b.id}:${n}:${k}`, STEP, () =>
							deletePayloadObjects(deps(), chunk.r2Keys),
						);
					}
					if (chunk.done) break;
				}
			}
			await step.do(`finish:${b.id}`, STEP, () => finishBatch(deps(), b.id));
		}
		await step.do("retention", STEP, () =>
			expireArchives(deps(), plan.storage, plan.now),
		);
		return { batches: plan.batches.length };
	}
}
