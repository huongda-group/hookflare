import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

declare global {
	// Test-only bindings injected via miniflare `bindings` in
	// vitest.config.ts. (Plain fixed test values, not real credentials.)
	// `env` from "cloudflare:workers" is typed as `Cloudflare.Env`,
	// so augment that interface rather than the global `Env`.
	namespace Cloudflare {
		interface Env {
			TEST_MIGRATIONS: D1Migration[];
			SECRETS_KEY: string;
			SECRETS_KEY_PREVIOUS: string;
		}
	}
}

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
