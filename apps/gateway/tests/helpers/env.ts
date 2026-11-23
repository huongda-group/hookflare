import { env } from "cloudflare:workers";
import type { AppEnv } from "../../src/env";

export const allowAllLimiter = {
	limit: async () => ({ success: true }),
} as unknown as RateLimit;
export const denyAllLimiter = {
	limit: async () => ({ success: false }),
} as unknown as RateLimit;

export function testEnv(overrides: Partial<AppEnv> = {}): AppEnv {
	return {
		...(env as unknown as AppEnv),
		LOG_LEVEL: "info",
		PUBLIC_BASE_URL: "",
		INGRESS_LIMITER: allowAllLimiter,
		LOGIN_LIMITER: allowAllLimiter,
		TURNSTILE_SITE_KEY: "",
		...overrides,
	};
}
