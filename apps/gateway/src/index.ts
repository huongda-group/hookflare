import { createApp } from "./app";
import { handleDeliveryBatch } from "./delivery/consumer";
import { DLQ_QUEUE, handleDlqBatch } from "./delivery/dlq";
import { createDeps, type DeliveryMessage } from "./deps";
import type { AppEnv } from "./env";
import { runScheduled } from "./jobs/scheduled";

export { DestinationLimiter } from "./delivery/limiter";
export { ArchiveWorkflow } from "./jobs/archive/workflow";

const app = createApp();

export default {
	fetch: app.fetch,
	async queue(batch, env) {
		const deps = createDeps(env);
		await (batch.queue === DLQ_QUEUE
			? handleDlqBatch(batch, deps)
			: handleDeliveryBatch(batch, deps));
	},
	async scheduled(controller, env) {
		await runScheduled(controller.cron, createDeps(env));
	},
} satisfies ExportedHandler<AppEnv, DeliveryMessage>;
