import type { AppEnv } from "../../env";

/**
 * Cloudflare's always-pass Turnstile secret (spec §6.5.1, local dev and e2e).
 * Dummy tokens verified against it carry neither an `action` nor a `hostname`,
 * so those two checks are skipped for this secret only.
 */
export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";

const SITEVERIFY_URL =
	"https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Siteverify rejects oversized tokens; checked before any fetch. */
const MAX_TOKEN_LENGTH = 2048;
const TIMEOUT_MS = 10_000;

export type TurnstileConfig =
	| { mode: "on"; siteKey: string; secret: string }
	| { mode: "off" }
	| { mode: "misconfigured" };

/**
 * Turnstile is optional (zero-setup first deploy) but never half-on: both
 * values must be present, or neither. Exactly one is a misconfiguration the
 * callers fail closed on (spec §6.5.1).
 */
export function turnstileConfig(env: AppEnv): TurnstileConfig {
	const siteKey = env.TURNSTILE_SITE_KEY ?? "";
	const secret = env.TURNSTILE_SECRET_KEY ?? "";
	if (siteKey.length > 0 && secret.length > 0) {
		return { mode: "on", siteKey, secret };
	}
	if (siteKey.length === 0 && secret.length === 0) {
		return { mode: "off" };
	}
	return { mode: "misconfigured" };
}

export type TurnstileAction = "login" | "setup";
export type TurnstileResult = "ok" | "failed" | "unavailable";

export type VerifyTurnstileInput = {
	secret: string;
	token: string | undefined;
	remoteIp: string | null;
	action: TurnstileAction;
	hostname: string;
};

type SiteverifyResponse = {
	success?: unknown;
	action?: unknown;
	hostname?: unknown;
};

/**
 * Verify a Turnstile token against siteverify (spec §6.5.1).
 *
 * Never throws and never fails open: a rejected or malformed token is
 * `"failed"` (403), while an unreachable, timed-out, non-2xx, or unparseable
 * siteverify is `"unavailable"` (503). Callers map both to their own error.
 */
export async function verifyTurnstile(
	fetchFn: typeof fetch,
	input: VerifyTurnstileInput,
): Promise<TurnstileResult> {
	// A missing, empty, or oversized token can never verify; skip the request.
	if (!input.token || input.token.length > MAX_TOKEN_LENGTH) {
		return "failed";
	}

	const form = new FormData();
	form.set("secret", input.secret);
	form.set("response", input.token);
	// Omitted when the caller has no client IP (spec §6.5.1 passes the
	// CF-Connecting-IP header, which can be absent in local dev).
	if (input.remoteIp !== null) {
		form.set("remoteip", input.remoteIp);
	}

	let response: Response;
	try {
		response = await fetchFn(SITEVERIFY_URL, {
			method: "POST",
			body: form,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch {
		// Network error, abort, or timeout.
		return "unavailable";
	}
	if (!response.ok) {
		return "unavailable";
	}

	let payload: SiteverifyResponse;
	try {
		payload = (await response.json()) as SiteverifyResponse;
	} catch {
		return "unavailable";
	}
	if (payload === null || typeof payload !== "object") {
		return "failed";
	}
	if (payload.success !== true) {
		return "failed";
	}
	// Dummy tokens for the test secret carry no action or hostname.
	if (input.secret === TURNSTILE_TEST_SECRET) {
		return "ok";
	}
	if (payload.action !== input.action) {
		return "failed";
	}
	if (payload.hostname !== input.hostname) {
		return "failed";
	}
	return "ok";
}
