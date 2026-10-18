import { defineConfig } from "@playwright/test";

// Spec §12.3: the built SPA served by `wrangler dev`, local D1, fresh DB
// per run (so onboarding is open) with the always-pass Turnstile test
// keys. The Worker serves both the assets and the API on one origin.
const PORT = 8788;

// Suite separation is mandatory: the fixture suite (redesign.spec.ts,
// route interception, never touches D1) and the live suite (smoke.spec.ts,
// real Worker + fresh D1) MUST run in separate processes
// (`pnpm e2e redesign.spec.ts`, then `pnpm e2e smoke.spec.ts`) — never one
// shared run — so fixture and live suites cannot share worker state.
export default defineConfig({
	testDir: "./e2e",
	timeout: 60_000,
	retries: process.env.CI ? 1 : 0,
	use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
	webServer: {
		command: `rm -rf ../../.wrangler/e2e && pnpm --dir ../.. exec wrangler d1 migrations apply DB --local --config apps/gateway/wrangler.jsonc --persist-to .wrangler/e2e && pnpm --dir ../.. exec wrangler dev --config apps/gateway/wrangler.jsonc --port ${PORT} --var SETUP_TOKEN:e2e-setup-token --var TURNSTILE_SITE_KEY:1x00000000000000000000AA --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA --var SECRETS_KEY:ptOEPIGX3zAeX8aB1D0Fak+xg9RDepObO/sBwFUrRXI= --persist-to .wrangler/e2e`,
		url: `http://127.0.0.1:${PORT}/healthz`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
