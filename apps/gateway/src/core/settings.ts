import { type RetryDefaults, retryDefaultsSchema } from "@hookflare/shared";
import { eq, sql } from "drizzle-orm";
import type { Db, Deps } from "../deps";
import { settings } from "./db/schema";
import { DEFAULT_POLICY, type Policy } from "./policy";

export const RETRY_DEFAULTS_KEY = "retry_defaults";
export const SETTINGS_CACHE_TTL_MS = 30_000;

export function toPolicy(r: RetryDefaults): Policy {
	return {
		timeoutMs: r.timeout_ms,
		maxAttempts: r.max_attempts,
		backoffBaseS: r.backoff_base_s,
		backoffMaxS: r.backoff_max_s,
	};
}

export function toRetryDefaults(p: Policy): RetryDefaults {
	return {
		timeout_ms: p.timeoutMs,
		max_attempts: p.maxAttempts,
		backoff_base_s: p.backoffBaseS,
		backoff_max_s: p.backoffMaxS,
	};
}

/** A missing, unparsable, or out-of-bounds row means DEFAULT_POLICY: deliveries never fail on it. */
export async function readRetryDefaults(
	db: Db,
): Promise<{ policy: Policy; updatedAt: number | null; corrupt: boolean }> {
	const row = await db
		.select()
		.from(settings)
		.where(eq(settings.key, RETRY_DEFAULTS_KEY))
		.get();
	if (!row) return { policy: DEFAULT_POLICY, updatedAt: null, corrupt: false };
	let raw: unknown;
	try {
		raw = JSON.parse(row.valueJson);
	} catch {
		return { policy: DEFAULT_POLICY, updatedAt: row.updatedAt, corrupt: true };
	}
	const parsed = retryDefaultsSchema.safeParse(raw);
	return {
		policy: parsed.success ? toPolicy(parsed.data) : DEFAULT_POLICY,
		updatedAt: row.updatedAt,
		corrupt: !parsed.success,
	};
}

let cached: { policy: Policy; expiresAt: number } | null = null;

/** Per-isolate, like the source cache: a change applies within the TTL (spec M4-8). */
export async function loadRetryDefaults(
	deps: Pick<Deps, "db" | "now">,
): Promise<Policy> {
	const now = deps.now();
	if (cached && cached.expiresAt > now) return cached.policy;
	const { policy } = await readRetryDefaults(deps.db);
	cached = { policy, expiresAt: now + SETTINGS_CACHE_TTL_MS };
	return policy;
}

export function clearRetryDefaultsCache(): void {
	cached = null;
}

/**
 * Unexecuted: batch it with the audit row (M3-7). With `expectedUpdatedAt`
 * (null = no row yet) the write only lands if nobody changed the row since
 * it was read; `.returning()` is then empty and the caller answers 409.
 */
export function upsertRetryDefaults(
	db: Db,
	value: RetryDefaults,
	at: number,
	expectedUpdatedAt?: number | null,
) {
	const valueJson = JSON.stringify(value);
	return db
		.insert(settings)
		.values({ key: RETRY_DEFAULTS_KEY, valueJson, updatedAt: at })
		.onConflictDoUpdate({
			target: settings.key,
			set: { valueJson, updatedAt: at },
			...(expectedUpdatedAt === undefined
				? {}
				: {
						setWhere:
							expectedUpdatedAt === null
								? sql`0`
								: eq(settings.updatedAt, expectedUpdatedAt),
					}),
		})
		.returning({ key: settings.key });
}
