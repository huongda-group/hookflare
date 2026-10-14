import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Fixed 32-byte test keys (base64). Do NOT use outside tests.
const TEST_SECRETS_KEY = "ERERERERERERERERERERERERERERERERERERERERERE=";
const TEST_SECRETS_KEY_PREVIOUS =
	"IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => {
			// Resolved against the vitest process cwd, which is this package
			// directory (same assumption as `configPath: "./wrangler.jsonc"`).
			const migrations = await readD1Migrations("migrations");
			return {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					// Local workerd (via miniflare) supports compat dates up to
					// 2026-10-13, one day behind wrangler.jsonc's 2026-10-14.
					// Pin tests to the newest locally supported date; the app
					// uses no date-gated runtime APIs, so behavior is identical.
					compatibilityDate: "2026-10-13",
					// Test-only bindings: setup file applies TEST_MIGRATIONS
					// to the test D1. (Plain values go in `bindings`, not
					// `vars`: the v4->v5 options converter drops top-level
					// `vars`, so vars never reach the worker env.)
					bindings: {
						TEST_MIGRATIONS: migrations,
						SECRETS_KEY: TEST_SECRETS_KEY,
						SECRETS_KEY_PREVIOUS: TEST_SECRETS_KEY_PREVIOUS,
					},
				},
			};
		}),
	],
	test: {
		setupFiles: ["./test/apply-migrations.ts"],
		// Vitest's persistent FS module cache defaults on, but the Workers
		// runtime has no host filesystem access (its VFS is rooted at an
		// empty /bundle), so cache reads fail deterministically with ENOENT.
		// Disable it: modules are transformed fresh each run instead.
		fsModuleCache: false,
	},
});
