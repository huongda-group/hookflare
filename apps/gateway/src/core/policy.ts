import type { DestinationRow } from "./db/schema";

export type Policy = {
	timeoutMs: number;
	maxAttempts: number;
	backoffBaseS: number;
	backoffMaxS: number;
};

export const DEFAULT_POLICY: Policy = {
	timeoutMs: 10_000,
	maxAttempts: 20,
	backoffBaseS: 30,
	backoffMaxS: 21_600,
};

export const MAX_DELAY_S = 43_200;

export type PolicyFields = Pick<
	DestinationRow,
	"timeoutMs" | "maxAttempts" | "backoffBaseS" | "backoffMaxS"
>;

export function resolvePolicy(d: PolicyFields, defaults: Policy): Policy {
	const backoffBaseS = d.backoffBaseS ?? defaults.backoffBaseS;
	return {
		timeoutMs: d.timeoutMs ?? defaults.timeoutMs,
		maxAttempts: d.maxAttempts ?? defaults.maxAttempts,
		backoffBaseS,
		backoffMaxS: Math.max(d.backoffMaxS ?? defaults.backoffMaxS, backoffBaseS),
	};
}
