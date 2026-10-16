import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				// Local workerd supports compat dates up to 2026-10-13, one day
				// behind wrangler.jsonc's 2026-10-14 (same as apps/gateway).
				compatibilityDate: "2026-10-13",
			},
		}),
	],
	test: {
		// Same as apps/gateway: the Workers runtime has no host filesystem
		// access, so Vitest's persistent FS module cache fails with ENOENT.
		fsModuleCache: false,
	},
});
