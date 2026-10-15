import type { DestinationRow } from "./db/schema";

export type Policy = {
	timeoutMs: number;
	maxAttempts: number;
	backoffBaseS: number;
	backoffMaxS: number;
};

/** Global retry defaults (spec M2-10); editable from Settings in M4. */
export const DEFAULT_POLICY: Policy = {
	timeoutMs: 10_000,
	maxAttempts: 20,
	backoffBaseS: 30,
	backoffMaxS: 21_600,
};

/** Cloudflare Queues accept delaySeconds up to 12 h (spec M2-5). */
export const MAX_DELAY_S = 43_200;

export function resolvePolicy(
	d: Pick<
		DestinationRow,
		"timeoutMs" | "maxAttempts" | "backoffBaseS" | "backoffMaxS"
	>,
): Policy {
	return {
		timeoutMs: d.timeoutMs ?? DEFAULT_POLICY.timeoutMs,
		maxAttempts: d.maxAttempts ?? DEFAULT_POLICY.maxAttempts,
		backoffBaseS: d.backoffBaseS ?? DEFAULT_POLICY.backoffBaseS,
		backoffMaxS: d.backoffMaxS ?? DEFAULT_POLICY.backoffMaxS,
	};
}
