import type { ErrorKind } from "../core/db/schema";
import type { Policy } from "../core/policy";
import { retryAfterDelaySeconds, retryDelaySeconds } from "./backoff";

export type Outcome = {
	status: "delivered" | "failed_final";
	errorKind: ErrorKind | null;
	httpStatus: number | null;
	/** Short, non-sensitive; stored as last_error / error_message. */
	error: string | null;
};

/** M1 is single-shot: every non-2xx is final. M2 adds retryable outcomes here. */
export function classifyResponse(httpStatus: number): Outcome {
	if (httpStatus >= 200 && httpStatus < 300) {
		return { status: "delivered", errorKind: null, httpStatus, error: null };
	}
	const errorKind: ErrorKind =
		httpStatus < 400 ? "http_3xx" : httpStatus < 500 ? "http_4xx" : "http_5xx";
	return {
		status: "failed_final",
		errorKind,
		httpStatus,
		error: `HTTP ${httpStatus}`,
	};
}

export function classifyError(err: unknown, timeoutMs: number): Outcome {
	if ((err as { name?: unknown })?.name === "TimeoutError") {
		return {
			status: "failed_final",
			errorKind: "timeout",
			httpStatus: null,
			error: `timeout after ${timeoutMs} ms`,
		};
	}
	const error =
		err instanceof Error ? `${err.name}: ${err.message}` : String(err);
	return {
		status: "failed_final",
		errorKind: "network",
		httpStatus: null,
		error: error.slice(0, 500),
	};
}

export type SendResult =
	| { kind: "response"; status: number; retryAfter: string | null }
	| { kind: "error"; error: unknown };

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
	if (result.kind === "error") {
		const timeout =
			(result.error as { name?: unknown } | null)?.name === "TimeoutError";
		const message = timeout
			? `timeout after ${ctx.policy.timeoutMs} ms`
			: (result.error instanceof Error
					? `${result.error.name}: ${result.error.message}`
					: String(result.error)
				).slice(0, 500);
		return retryable(timeout ? "timeout" : "network", null, message, ctx, null);
	}
	const { status } = result;
	if (status >= 200 && status < 300) {
		return {
			status: "delivered",
			errorKind: null,
			httpStatus: status,
			error: null,
			delaySeconds: null,
		};
	}
	const errorKind: ErrorKind =
		status < 400 ? "http_3xx" : status < 500 ? "http_4xx" : "http_5xx";
	const error = `HTTP ${status}`;
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
