import { describe, expect, it, vi } from "vitest";
import {
	TURNSTILE_TEST_SECRET,
	turnstileConfig,
	verifyTurnstile,
} from "../../../src/admin/auth/turnstile";
import { createApp } from "../../../src/app";
import { testEnv } from "../../helpers/env";

const SITEVERIFY_URL =
	"https://challenges.cloudflare.com/turnstile/v0/siteverify";

const INPUT = {
	secret: "turnstile-secret",
	token: "token-value",
	remoteIp: "203.0.113.7",
	action: "login" as const,
	hostname: "hooks.example.com",
};

/** A fetch stub returning a JSON body; the args are recorded for assertions. */
function fetchStub(body: unknown, status = 200) {
	return vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify(body), { status }),
	);
}

function asFetch(fn: ReturnType<typeof fetchStub>): typeof fetch {
	return fn as unknown as typeof fetch;
}

describe("turnstileConfig", () => {
	it("is on with both keys set and returns both values", () => {
		expect(
			turnstileConfig(
				testEnv({
					TURNSTILE_SITE_KEY: "site-key",
					TURNSTILE_SECRET_KEY: "secret-key",
				}),
			),
		).toEqual({ mode: "on", siteKey: "site-key", secret: "secret-key" });
	});

	it("is off when neither key is set", () => {
		expect(turnstileConfig(testEnv())).toEqual({ mode: "off" });
	});

	it("is off when both keys are empty strings (the wrangler default)", () => {
		expect(
			turnstileConfig(
				testEnv({ TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "" }),
			),
		).toEqual({ mode: "off" });
	});

	it("is misconfigured when only the site key is set", () => {
		expect(
			turnstileConfig(testEnv({ TURNSTILE_SITE_KEY: "site-key" })),
		).toEqual({ mode: "misconfigured" });
	});

	it("is misconfigured when only the secret is set", () => {
		expect(
			turnstileConfig(testEnv({ TURNSTILE_SECRET_KEY: "secret-key" })),
		).toEqual({ mode: "misconfigured" });
	});
});

describe("verifyTurnstile", () => {
	it("returns ok for success with matching action and hostname", async () => {
		const fetchFn = fetchStub({
			success: true,
			action: "login",
			hostname: "hooks.example.com",
		});
		await expect(verifyTurnstile(asFetch(fetchFn), INPUT)).resolves.toBe("ok");
	});

	it("posts the secret, response, and remoteip as form data", async () => {
		const fetchFn = fetchStub({
			success: true,
			action: "login",
			hostname: "hooks.example.com",
		});
		await verifyTurnstile(asFetch(fetchFn), INPUT);

		expect(fetchFn).toHaveBeenCalledTimes(1);
		const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(SITEVERIFY_URL);
		expect(init.method).toBe("POST");
		const form = init.body as FormData;
		expect(form.get("secret")).toBe("turnstile-secret");
		expect(form.get("response")).toBe("token-value");
		expect(form.get("remoteip")).toBe("203.0.113.7");
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("omits remoteip when it is null", async () => {
		const fetchFn = fetchStub({
			success: true,
			action: "setup",
			hostname: "hooks.example.com",
		});
		await verifyTurnstile(asFetch(fetchFn), {
			...INPUT,
			remoteIp: null,
			action: "setup",
		});
		const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		expect((init.body as FormData).has("remoteip")).toBe(false);
	});

	it("returns failed on an action mismatch", async () => {
		const fetchFn = fetchStub({
			success: true,
			action: "setup",
			hostname: "hooks.example.com",
		});
		await expect(verifyTurnstile(asFetch(fetchFn), INPUT)).resolves.toBe(
			"failed",
		);
	});

	it("returns failed on a hostname mismatch", async () => {
		const fetchFn = fetchStub({
			success: true,
			action: "login",
			hostname: "evil.example.com",
		});
		await expect(verifyTurnstile(asFetch(fetchFn), INPUT)).resolves.toBe(
			"failed",
		);
	});

	it("returns failed when success is false (reused or expired token)", async () => {
		const fetchFn = fetchStub({ success: false });
		await expect(verifyTurnstile(asFetch(fetchFn), INPUT)).resolves.toBe(
			"failed",
		);
	});

	it("returns failed when success is missing or not boolean", async () => {
		for (const body of [{}, { success: "true" }, { success: 1 }]) {
			const fetchFn = fetchStub(body);
			await expect(verifyTurnstile(asFetch(fetchFn), INPUT)).resolves.toBe(
				"failed",
			);
		}
	});

	it("returns unavailable on a non-2xx response", async () => {
		for (const status of [400, 429, 500, 503]) {
			const fetchFn = fetchStub({ success: false }, status);
			await expect(verifyTurnstile(asFetch(fetchFn), INPUT)).resolves.toBe(
				"unavailable",
			);
		}
	});

	it("returns unavailable when the fetch throws (network error or timeout)", async () => {
		const abort = vi.fn(async () => {
			throw new DOMException("The operation was aborted.", "AbortError");
		});
		await expect(verifyTurnstile(asFetch(abort), INPUT)).resolves.toBe(
			"unavailable",
		);

		const boom = vi.fn(async () => {
			throw new TypeError("network failed");
		});
		await expect(verifyTurnstile(asFetch(boom), INPUT)).resolves.toBe(
			"unavailable",
		);
	});

	it("returns unavailable when the body is not valid JSON", async () => {
		const fetchFn = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response("not json", { status: 200 }),
		);
		await expect(verifyTurnstile(asFetch(fetchFn), INPUT)).resolves.toBe(
			"unavailable",
		);
	});

	it("returns failed for a missing, empty, or oversized token without fetching", async () => {
		const tooLong = "a".repeat(2049);
		for (const token of [undefined, "", tooLong]) {
			const fetchFn = fetchStub({ success: true });
			await expect(
				verifyTurnstile(asFetch(fetchFn), { ...INPUT, token }),
			).resolves.toBe("failed");
			expect(fetchFn).not.toHaveBeenCalled();
		}
	});

	it("accepts a token of exactly 2048 characters", async () => {
		const fetchFn = fetchStub({
			success: true,
			action: "login",
			hostname: "hooks.example.com",
		});
		await expect(
			verifyTurnstile(asFetch(fetchFn), { ...INPUT, token: "a".repeat(2048) }),
		).resolves.toBe("ok");
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("skips the action and hostname checks for the test secret", async () => {
		const fetchFn = fetchStub({ success: true });
		await expect(
			verifyTurnstile(asFetch(fetchFn), {
				...INPUT,
				secret: TURNSTILE_TEST_SECRET,
				action: "setup",
				hostname: "other.example.com",
			}),
		).resolves.toBe("ok");
	});

	it("still requires success for the test secret", async () => {
		const fetchFn = fetchStub({ success: false });
		await expect(
			verifyTurnstile(asFetch(fetchFn), {
				...INPUT,
				secret: TURNSTILE_TEST_SECRET,
			}),
		).resolves.toBe("failed");
	});
});

describe("GET /healthz turnstile state", () => {
	it("reports turnstile:off under testEnv()", async () => {
		const res = await createApp().request("/healthz", {}, testEnv());
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({ turnstile: "off" });
	});

	it("reports turnstile:on when both keys are set, without changing the status", async () => {
		const res = await createApp().request(
			"/healthz",
			{},
			testEnv({
				TURNSTILE_SITE_KEY: "site-key",
				TURNSTILE_SECRET_KEY: "secret-key",
			}),
		);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({ turnstile: "on" });
	});

	it("reports turnstile:misconfigured when only one key is set, without failing", async () => {
		const res = await createApp().request(
			"/healthz",
			{},
			testEnv({ TURNSTILE_SITE_KEY: "site-key" }),
		);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({
			turnstile: "misconfigured",
		});
	});
});
