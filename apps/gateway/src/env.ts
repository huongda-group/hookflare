import type { SecretsEnv } from "./core/crypto";

export type AppEnv = Env & SecretsEnv & { TURNSTILE_SECRET_KEY?: string };
