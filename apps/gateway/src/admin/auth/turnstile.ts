import type { AppEnv } from "../../env";

export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";

const SITEVERIFY_URL =
	"https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2048;
const TIMEOUT_MS = 10_000;

export type TurnstileConfig =
	| { mode: "on"; siteKey: string; secret: string }
	| { mode: "off" }
	| { mode: "misconfigured" };

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

export async function verifyTurnstile(
	fetchFn: typeof fetch,
	input: VerifyTurnstileInput,
): Promise<TurnstileResult> {
	if (!input.token || input.token.length > MAX_TOKEN_LENGTH) {
		return "failed";
	}

	const form = new FormData();
	form.set("secret", input.secret);
	form.set("response", input.token);
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
