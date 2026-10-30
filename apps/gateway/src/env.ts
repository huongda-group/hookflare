import type { SecretsEnv } from "./core/crypto";

/**
 * Generated bindings + values `wrangler types` cannot see: Worker secrets
 * (`wrangler secret put`) such as `TURNSTILE_SECRET_KEY`.
 */
export type AppEnv = Env & SecretsEnv & { TURNSTILE_SECRET_KEY?: string };
