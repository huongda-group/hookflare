import type { SecretsEnv } from "./core/crypto";

/**
 * Generated bindings + values `wrangler types` cannot see: secrets
 * (`wrangler secret put`) and the local-only Access bypass.
 */
export type AppEnv = Env & SecretsEnv & { ACCESS_DEV_EMAIL?: string };
