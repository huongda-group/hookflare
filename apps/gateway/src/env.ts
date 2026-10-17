import type { SecretsEnv } from "./core/crypto";

/**
 * Generated bindings + values `wrangler types` cannot see: Worker secrets
 * (`wrangler secret put`) such as `SETUP_TOKEN` and `TURNSTILE_SECRET_KEY`.
 */
export type AppEnv = Env &
	SecretsEnv & { SETUP_TOKEN?: string; TURNSTILE_SECRET_KEY?: string };
