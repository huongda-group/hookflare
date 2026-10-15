import type { SourceBundle } from "./db/sources";

export const SOURCE_CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 1000;

/**
 * Per-isolate cache for ingress lookups, including "not found" (null).
 * Admin changes become visible within the TTL; there is no active
 * invalidation in M1 (documented staleness, spec §6 step 1).
 */
const cache = new Map<
	string,
	{ bundle: SourceBundle | null; expiresAt: number }
>();

export function getCachedSource(
	sourceId: string,
	now: number,
): SourceBundle | null | undefined {
	const hit = cache.get(sourceId);
	if (!hit) {
		return undefined;
	}
	if (hit.expiresAt <= now) {
		cache.delete(sourceId);
		return undefined;
	}
	return hit.bundle;
}

export function setCachedSource(
	sourceId: string,
	bundle: SourceBundle | null,
	now: number,
): void {
	if (cache.size >= MAX_ENTRIES) {
		const oldest = cache.keys().next();
		if (!oldest.done) cache.delete(oldest.value);
	}
	cache.set(sourceId, { bundle, expiresAt: now + SOURCE_CACHE_TTL_MS });
}

export function clearSourceCache(): void {
	cache.clear();
}
