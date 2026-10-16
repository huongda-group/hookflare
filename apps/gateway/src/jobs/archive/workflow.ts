import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import type { ArchiveParams } from "../../core/archive-run";
import { createLogger } from "../../core/log";
import { createDeps, type Deps } from "../../deps";
import { runArchive, type StepFn } from "./run";

const STEP = {
	retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
	timeout: "10 minutes",
} as const;

/** Spec §7.4. The orchestration lives in `runArchive`; this binds it to step.do(). */
export class ArchiveWorkflow extends WorkflowEntrypoint<
	Deps["env"],
	ArchiveParams
> {
	async run(event: WorkflowEvent<ArchiveParams>, step: WorkflowStep) {
		const logger = createLogger(this.env, {
			workflow: "archive",
			instance_id: event.instanceId,
		});
		const durable = ((name: string, fn: () => Promise<unknown>) =>
			step.do(name, STEP, fn as never)) as StepFn;
		return runArchive(
			durable,
			() => createDeps(this.env),
			event.instanceId,
			logger,
		);
	}
}
