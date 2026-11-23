import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const TEST_SECRETS_KEY = "ERERERERERERERERERERERERERERERERERERERERERE=";
const TEST_SECRETS_KEY_PREVIOUS =
	"IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => {
			const migrations = await readD1Migrations("migrations");
			return {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					compatibilityDate: "2026-10-13",
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
		coverage: {
			provider: "istanbul",
			include: ["src/**/*.ts"],
			thresholds: {
				lines: 100,
				branches: 100,
				functions: 100,
				statements: 100,
			},
		},
		setupFiles: ["./tests/apply-migrations.ts"],
		fsModuleCache: false,
	},
});
