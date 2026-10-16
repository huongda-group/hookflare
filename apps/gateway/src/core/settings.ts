import {
	type AlertRules,
	alertRulesSchema,
	DEFAULT_ALERT_RULES,
	type RetryDefaults,
	retryDefaultsSchema,
} from "@hookflare/shared";
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
	return upsertSetting(db, RETRY_DEFAULTS_KEY, value, at, expectedUpdatedAt);
}

export type SettingSpec<T> = {
	key: string;
	schema: {
		safeParse(v: unknown): { success: true; data: T } | { success: false };
	};
	fallback: T;
};

export const ALERT_RULES_SETTING: SettingSpec<AlertRules> = {
	key: "alert_rules",
	schema: alertRulesSchema,
	fallback: DEFAULT_ALERT_RULES,
};

/** A missing, unparsable, or out-of-bounds row means the fallback; callers decide whether corrupt matters. */
export async function readSetting<T>(
	db: Db,
	spec: SettingSpec<T>,
): Promise<{ value: T; updatedAt: number | null; corrupt: boolean }> {
	const row = await db
		.select()
		.from(settings)
		.where(eq(settings.key, spec.key))
		.get();
	if (!row) return { value: spec.fallback, updatedAt: null, corrupt: false };
	let raw: unknown;
	try {
		raw = JSON.parse(row.valueJson);
	} catch {
		return { value: spec.fallback, updatedAt: row.updatedAt, corrupt: true };
	}
	const parsed = spec.schema.safeParse(raw);
	return parsed.success
		? { value: parsed.data, updatedAt: row.updatedAt, corrupt: false }
		: { value: spec.fallback, updatedAt: row.updatedAt, corrupt: true };
}

/**
 * Unexecuted: batch it with the audit row (M3-7). With `expectedUpdatedAt`
 * (null = no row yet) the write only lands if nobody changed the row since
 * it was read; `.returning()` is then empty and the caller answers 409.
 */
export function upsertSetting(
	db: Db,
	key: string,
	value: unknown,
	at: number,
	expectedUpdatedAt?: number | null,
) {
	const valueJson = JSON.stringify(value);
	return db
		.insert(settings)
		.values({ key, valueJson, updatedAt: at })
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

const caches: { clear(): void }[] = [];

/** Per-isolate, like retry_defaults: a change applies within the TTL (spec M4-8). */
export function cachedSetting<T>(spec: SettingSpec<T>) {
	let cached: { value: T; expiresAt: number } | null = null;
	const cache = {
		async load(deps: Pick<Deps, "db" | "now">): Promise<T> {
			const now = deps.now();
			if (cached && cached.expiresAt > now) return cached.value;
			const { value } = await readSetting(deps.db, spec);
			cached = { value, expiresAt: now + SETTINGS_CACHE_TTL_MS };
			return value;
		},
		clear() {
			cached = null;
		},
	};
	caches.push(cache);
	return cache;
}

const alertRulesCache = cachedSetting(ALERT_RULES_SETTING);
export const loadAlertRules = alertRulesCache.load;

export function clearSettingsCache(): void {
	clearRetryDefaultsCache();
	for (const c of caches) c.clear();
}
