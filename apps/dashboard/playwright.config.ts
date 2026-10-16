import { defineConfig } from "@playwright/test";

// Spec §12.3: the built SPA served by `wrangler dev`, local D1, Access dev
// bypass. The Worker serves both the assets and the API on one origin.
const PORT = 8788;

export default defineConfig({
	testDir: "./e2e",
	timeout: 60_000,
	retries: process.env.CI ? 1 : 0,
	use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
	webServer: {
		command: `pnpm --dir ../.. exec wrangler d1 migrations apply DB --local --config apps/gateway/wrangler.jsonc --persist-to .wrangler/e2e && pnpm --dir ../.. exec wrangler dev --config apps/gateway/wrangler.jsonc --port ${PORT} --var ACCESS_DEV_EMAIL:e2e-admin@example.com --var BOOTSTRAP_ADMIN_EMAILS:e2e-admin@example.com --var SECRETS_KEY:ptOEPIGX3zAeX8aB1D0Fak+xg9RDepObO/sBwFUrRXI= --persist-to .wrangler/e2e`,
		url: `http://127.0.0.1:${PORT}/healthz`,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
