import { createApp } from "./app";
import type { AppEnv } from "./env";

const app = createApp();

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<AppEnv>;
