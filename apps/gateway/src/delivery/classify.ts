import type { ErrorKind } from "../core/db/schema";

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
