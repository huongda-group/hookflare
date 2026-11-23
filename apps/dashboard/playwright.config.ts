import { defineConfig } from "@playwright/test";

const PORT = 8788;

export default defineConfig({
	testDir: "./tests/e2e",
	timeout: 60_000,
	retries: process.env.CI ? 1 : 0,
	use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
	webServer: {
		command: `rm -rf ../../.wrangler/e2e && pnpm --dir ../.. exec wrangler d1 migrations apply DB --local --config apps/gateway/wrangler.jsonc --persist-to .wrangler/e2e && pnpm --dir ../.. exec wrangler dev --config apps/gateway/wrangler.jsonc --port ${PORT} --var TURNSTILE_SITE_KEY:1x00000000000000000000AA --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA --var SECRETS_KEY:ptOEPIGX3zAeX8aB1D0Fak+xg9RDepObO/sBwFUrRXI= --persist-to .wrangler/e2e`,
		url: `http://127.0.0.1:${PORT}/healthz`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
