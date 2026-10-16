import type { Deps } from "../deps";
import type { ErrorKind } from "./db/schema";

export const SNIPPET_BYTES = 2048;

export type SendResult =
	| { kind: "response"; status: number; retryAfter: string | null }
	| { kind: "error"; error: unknown };

/** At most `maxBytes` of the body as lossy UTF-8; stream errors keep what was read. */
export async function readSnippet(
	response: Response,
	maxBytes = SNIPPET_BYTES,
): Promise<string | null> {
	if (!response.body) {
		return null;
	}
	const reader = response.body.getReader();
	const buf = new Uint8Array(maxBytes);
	let len = 0;
	try {
		while (len < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			const take = Math.min(value.byteLength, maxBytes - len);
			buf.set(value.subarray(0, take), len);
			len += take;
		}
	} catch {
		// Keep the partial snippet; the HTTP status already decided the outcome.
	} finally {
		reader.cancel().catch(() => {});
	}
	return len === 0 ? null : new TextDecoder().decode(buf.subarray(0, len));
}

/** Error kind and a short, non-sensitive message; null for 2xx. */
export function failureOf(
	result: SendResult,
	timeoutMs: number,
): { errorKind: ErrorKind; message: string } | null {
	if (result.kind === "error") {
		const timeout =
			(result.error as { name?: unknown } | null)?.name === "TimeoutError";
		return timeout
			? { errorKind: "timeout", message: `timeout after ${timeoutMs} ms` }
			: {
					errorKind: "network",
					message: (result.error instanceof Error
						? `${result.error.name}: ${result.error.message}`
						: String(result.error)
					).slice(0, 500),
				};
	}
	const { status } = result;
	if (status >= 200 && status < 300) return null;
	return {
		errorKind:
			status < 400 ? "http_3xx" : status < 500 ? "http_4xx" : "http_5xx",
		message: `HTTP ${status}`,
	};
}

/** One outbound POST: HTTPS was checked by the caller; never follows redirects. */
export async function sendSigned(
	deps: Deps,
	req: {
		url: string;
		headers: Headers;
		body: Uint8Array<ArrayBuffer>;
		timeoutMs: number;
	},
): Promise<{ result: SendResult; snippet: string | null; durationMs: number }> {
	const started = Date.now();
	try {
		const response = await deps.fetch(req.url, {
			method: "POST",
			headers: req.headers,
			body: req.body,
			redirect: "manual",
			signal: AbortSignal.timeout(req.timeoutMs),
		});
		return {
			result: {
				kind: "response",
				status: response.status,
				retryAfter: response.headers.get("retry-after"),
			},
			snippet: await readSnippet(response),
			durationMs: Date.now() - started,
		};
	} catch (error) {
		return {
			result: { kind: "error", error },
			snippet: null,
			durationMs: Date.now() - started,
		};
	}
}
