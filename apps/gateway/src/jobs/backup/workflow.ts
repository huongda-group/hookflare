import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import type { BackupParams } from "../../core/backup-run";
import { createLogger } from "../../core/log";
import type { StepFn } from "../../core/workflow";
import { createDeps, type Deps } from "../../deps";
import { runBackup } from "./run";

const STEP = {
	retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
	timeout: "10 minutes",
} as const;

/** Spec M6. The orchestration lives in `runBackup`; this binds it to step.do(). */
export class BackupWorkflow extends WorkflowEntrypoint<
	Deps["env"],
	BackupParams
> {
	async run(event: WorkflowEvent<BackupParams>, step: WorkflowStep) {
		const logger = createLogger(this.env, {
			workflow: "backup",
			instance_id: event.instanceId,
		});
		const durable = ((name: string, fn: () => Promise<unknown>) =>
			step.do(name, STEP, fn as never)) as StepFn;
		return runBackup(
			durable,
			() => createDeps(this.env),
			event.payload,
			event.instanceId,
			logger,
		);
	}
}
