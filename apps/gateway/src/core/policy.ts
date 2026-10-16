import type { DestinationRow } from "./db/schema";

export type Policy = {
	timeoutMs: number;
	maxAttempts: number;
	backoffBaseS: number;
	backoffMaxS: number;
};

/** Fallback retry defaults when Settings has no row (spec M4-8). */
export const DEFAULT_POLICY: Policy = {
	timeoutMs: 10_000,
	maxAttempts: 20,
	backoffBaseS: 30,
	backoffMaxS: 21_600,
};

/** Cloudflare Queues accept delaySeconds up to 12 h (spec M2-5). */
export const MAX_DELAY_S = 43_200;

export type PolicyFields = Pick<
	DestinationRow,
	"timeoutMs" | "maxAttempts" | "backoffBaseS" | "backoffMaxS"
>;

/**
 * A destination field always wins over the defaults. backoff_max_s is raised
 * to backoff_base_s: changing the defaults must never leave a destination with
 * max < base (both are ≤ MAX_DELAY_S, so the result stays valid).
 */
export function resolvePolicy(d: PolicyFields, defaults: Policy): Policy {
	const backoffBaseS = d.backoffBaseS ?? defaults.backoffBaseS;
	return {
		timeoutMs: d.timeoutMs ?? defaults.timeoutMs,
		maxAttempts: d.maxAttempts ?? defaults.maxAttempts,
		backoffBaseS,
		backoffMaxS: Math.max(d.backoffMaxS ?? defaults.backoffMaxS, backoffBaseS),
	};
}
