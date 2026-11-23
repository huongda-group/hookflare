import { describe, expect, it, vi } from "vitest";
import {
	ALERT_MESSAGE_MAX,
	channelRequest,
	formatAlertMessage,
	openChannelConfig,
	sealChannelConfig,
	sendAlert,
} from "../../src/core/alert-channels";
import { testEnv } from "../helpers/env";

const discord = {
	type: "discord",
	url: "https://discord.com/api/webhooks/1/abc",
} as const;
const slack = {
	type: "slack",
	url: "https://hooks.slack.com/services/T/B/x",
} as const;
const token = `123456:${"A".repeat(35)}`;
const telegram = {
	type: "telegram",
	bot_token: token,
	chat_id: "-100123",
} as const;

function fetchReturning(status: number, headers: Record<string, string> = {}) {
	// 204/205/304 cannot carry a body — use null for null-body statuses.
	const body = status === 204 || status === 205 || status === 304 ? null : "x";
	return vi.fn(
		async () => new Response(body, { status, headers }),
	) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("channelRequest (spec §6.4)", () => {
	it("builds the three payloads", () => {
		expect(channelRequest(discord, "hi")).toEqual({
			url: discord.url,
			body: JSON.stringify({ content: "hi" }),
		});
		expect(channelRequest(slack, "hi")).toEqual({
			url: slack.url,
			body: JSON.stringify({ text: "hi" }),
		});
		expect(channelRequest(telegram, "hi")).toEqual({
			url: `https://api.telegram.org/bot${token}/sendMessage`,
			body: JSON.stringify({
				chat_id: "-100123",
				text: "hi",
				disable_web_page_preview: true,
			}),
		});
	});
});

describe("sendAlert", () => {
	it("posts JSON with redirect: manual and treats 2xx as success", async () => {
		const f = fetchReturning(204);
		expect(await sendAlert(f, discord, "hi")).toEqual({ ok: true });
		const [url, init] = f.mock.calls[0];
		expect(url).toBe(discord.url);
		expect(init).toMatchObject({ method: "POST", redirect: "manual" });
		expect(new Headers(init.headers).get("content-type")).toBe(
			"application/json",
		);
	});

	it("counts a redirect as a failure and never follows it (Review Focus 2)", async () => {
		const f = fetchReturning(301, { location: "https://evil.example/" });
		expect(await sendAlert(f, slack, "hi")).toEqual({
			ok: false,
			error: "HTTP 301",
		});
		expect(f).toHaveBeenCalledTimes(1);
	});

	it("counts 429 and 5xx as failures", async () => {
		expect(await sendAlert(fetchReturning(429), discord, "x")).toEqual({
			ok: false,
			error: "HTTP 429",
		});
		expect(await sendAlert(fetchReturning(503), discord, "x")).toEqual({
			ok: false,
			error: "HTTP 503",
		});
	});

	it("refuses a config that is not on the allowlist, without fetching", async () => {
		const f = fetchReturning(200);
		const r = await sendAlert(
			f,
			{ type: "discord", url: "https://example.com/api/webhooks/1" },
			"x",
		);
		expect(r).toEqual({ ok: false, error: "url_not_allowed" });
		expect(f).not.toHaveBeenCalled();
	});

	it("never leaks the Telegram token in an error", async () => {
		const f = vi.fn(async () => {
			throw new Error(
				`fetch failed for https://api.telegram.org/bot${token}/sendMessage`,
			);
		}) as unknown as typeof fetch;
		const r = await sendAlert(f, telegram, "x");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).not.toContain(token);
			expect(r.error.length).toBeLessThanOrEqual(200);
		}
	});
});

describe("formatAlertMessage", () => {
	it("contains the rule, resource, project, and link", () => {
		const text = formatAlertMessage({
			kind: "opened",
			rule: "consecutive_failures",
			resourceLabel: "Billing API",
			projectLabel: "Shop",
			details: { consecutive_failures: 5 },
			link: "https://hf.example/alerts/alr_1",
		});
		expect(text).toContain("consecutive_failures");
		expect(text).toContain("Billing API");
		expect(text).toContain("Shop");
		expect(text).toContain("https://hf.example/alerts/alr_1");
	});

	it("cuts long messages to 1,800 characters and keeps the link (Review Focus 3)", () => {
		const text = formatAlertMessage({
			kind: "opened",
			rule: "new_dead",
			resourceLabel: "x".repeat(3_000),
			projectLabel: "p",
			details: { ids: Array.from({ length: 500 }, (_, i) => `dlv_${i}`) },
			link: "https://hf.example/alerts/alr_2",
		});
		expect(text.length).toBeLessThanOrEqual(ALERT_MESSAGE_MAX);
		expect(text.endsWith("https://hf.example/alerts/alr_2")).toBe(true);
	});
});

describe("channel config sealing", () => {
	it("round-trips and fingerprints without exposing the secret", async () => {
		const env = testEnv();
		const sealed = await sealChannelConfig(env, "ach_1", telegram);
		expect(sealed.configEnc).not.toContain(token);
		expect(sealed.configFingerprint).toMatch(/^[0-9a-f]{8}$/);
		expect(sealed.chatId).toBe("-100123");
		expect(await openChannelConfig(env, "ach_1", sealed.configEnc)).toEqual(
			telegram,
		);
		await expect(
			openChannelConfig(env, "ach_2", sealed.configEnc),
		).rejects.toThrow();
	});
});
