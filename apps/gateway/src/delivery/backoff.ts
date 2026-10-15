import { MAX_DELAY_S, type Policy } from "../core/policy";

const clamp = (v: number, lo: number, hi: number) =>
	Math.min(Math.max(v, lo), hi);

/** Delay after failed attempt n: min(base·2^(n−1), max) ±20 % (spec §7.3). */
export function retryDelaySeconds(
	n: number,
	policy: Policy,
	random: () => number,
): number {
	const raw = Math.min(policy.backoffBaseS * 2 ** (n - 1), policy.backoffMaxS);
	return clamp(Math.round(raw * (0.8 + 0.4 * random())), 1, MAX_DELAY_S);
}

/** Seconds until the Retry-After instant (may be ≤ 0); null when absent or invalid. */
export function parseRetryAfter(
	value: string | null,
	now: number,
): number | null {
	if (value === null) return null;
	const v = value.trim();
	if (/^\d+$/.test(v)) return Number(v);
	// HTTP-date (IMF-fixdate); Date.parse alone would accept far looser input.
	if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v)) {
		return null;
	}
	const at = Date.parse(v);
	return Number.isNaN(at) ? null : Math.ceil((at - now) / 1000);
}

/** Retry-After for a 429: clamped to [1, backoff_max_s], no jitter. */
export function retryAfterDelaySeconds(
	value: string | null,
	now: number,
	policy: Policy,
): number | null {
	const seconds = parseRetryAfter(value, now);
	return seconds === null ? null : clamp(seconds, 1, policy.backoffMaxS);
}

/** msg.retry delay after an infra error: 60 s doubling, capped at 1 h (spec M2-6). */
export function infraDelaySeconds(msgAttempts: number): number {
	return Math.min(60 * 2 ** (Math.max(msgAttempts, 1) - 1), 3600);
}
