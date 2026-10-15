import { createApp } from "./app";
import { handleDeliveryBatch } from "./delivery/consumer";
import { createDeps, type DeliveryMessage } from "./deps";
import type { AppEnv } from "./env";

const app = createApp();

export default {
	fetch: app.fetch,
	async queue(batch, env) {
		await handleDeliveryBatch(batch, createDeps(env));
	},
} satisfies ExportedHandler<AppEnv, DeliveryMessage>;
