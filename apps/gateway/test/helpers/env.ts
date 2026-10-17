import { env } from "cloudflare:workers";
import type { AppEnv } from "../../src/env";

export const ACCESS_TEST = {
	teamDomain: "https://test.cloudflareaccess.com",
	aud: "test-aud",
	admin: "admin@example.com",
} as const;

export const allowAllLimiter = {
	limit: async () => ({ success: true }),
} as unknown as RateLimit;
export const denyAllLimiter = {
	limit: async () => ({ success: false }),
} as unknown as RateLimit;

/**
 * The test worker env plus every var the app reads. wrangler.jsonc `vars`
 * never reach tests (see vitest.config.ts), so they are set here.
 */
export function testEnv(overrides: Partial<AppEnv> = {}): AppEnv {
	return {
		...(env as unknown as AppEnv),
		LOG_LEVEL: "info",
		PUBLIC_BASE_URL: "",
		INGRESS_LIMITER: allowAllLimiter,
		LOGIN_LIMITER: allowAllLimiter,
		SETUP_TOKEN: "test-setup-token",
		TURNSTILE_SITE_KEY: "",
		...overrides,
	};
}
