import type { ErrorKind } from "../core/db/schema";
import { failureOf, type SendResult } from "../core/outbound";
import type { Policy } from "../core/policy";
import { retryAfterDelaySeconds, retryDelaySeconds } from "./backoff";

export type { SendResult };

export type AttemptContext = {
	/** attempt_count + 1 for this attempt. */
	attemptNo: number;
	policy: Policy;
	now: number;
	random: () => number;
};

export type AttemptOutcome = {
	errorKind: ErrorKind | null;
	httpStatus: number | null;
	/** Short, non-sensitive; stored as last_error / error_message. */
	error: string | null;
} & (
	| { status: "retrying"; delaySeconds: number }
	| { status: "delivered" | "dead" | "failed_final"; delaySeconds: null }
);

const RETRYABLE_4XX = new Set([408, 429]);

/** Spec §7.1. Pure: the caller passes the clock and the jitter source. */
export function classifyAttempt(
	result: SendResult,
	ctx: AttemptContext,
): AttemptOutcome {
	const failure = failureOf(result, ctx.policy.timeoutMs);
	if (result.kind === "error") {
		// failure is non-null for every error result
		const f = failure as NonNullable<typeof failure>;
		return retryable(f.errorKind, null, f.message, ctx, null);
	}
	const { status } = result;
	if (!failure) {
		return {
			status: "delivered",
			errorKind: null,
			httpStatus: status,
			error: null,
			delaySeconds: null,
		};
	}
	const { errorKind, message: error } = failure;
	if (status >= 500 || RETRYABLE_4XX.has(status)) {
		return retryable(
			errorKind,
			status,
			error,
			ctx,
			status === 429 ? result.retryAfter : null,
		);
	}
	return {
		status: "failed_final",
		errorKind,
		httpStatus: status,
		error,
		delaySeconds: null,
	};
}

function retryable(
	errorKind: ErrorKind,
	httpStatus: number | null,
	error: string,
	ctx: AttemptContext,
	retryAfter: string | null,
): AttemptOutcome {
	if (ctx.attemptNo >= ctx.policy.maxAttempts) {
		return { status: "dead", errorKind, httpStatus, error, delaySeconds: null };
	}
	const delaySeconds =
		retryAfterDelaySeconds(retryAfter, ctx.now, ctx.policy) ??
		retryDelaySeconds(ctx.attemptNo, ctx.policy, ctx.random);
	return { status: "retrying", errorKind, httpStatus, error, delaySeconds };
}
