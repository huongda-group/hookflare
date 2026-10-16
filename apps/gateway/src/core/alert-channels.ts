import {
	type AlertChannelConfig,
	type AlertRule,
	isAllowedAlertUrl,
	TELEGRAM_TOKEN_RE,
} from "@hookflare/shared";
import type { AppEnv } from "../env";
import { decryptSecret, encryptSecret, secretFingerprint } from "./crypto";

export const ALERT_MESSAGE_MAX = 1_800;
export const ALERT_SEND_TIMEOUT_MS = 5_000;
const ERROR_MAX = 200;

export type AlertMessageInput = {
	kind: "opened" | "reminder" | "resolved" | "test";
	rule: AlertRule | null;
	resourceLabel: string;
	projectLabel: string | null;
	details: Record<string, unknown>;
	link: string | null;
};

const HEADLINE: Record<AlertMessageInput["kind"], string> = {
	opened: "🔴 Hookflare alert",
	reminder: "🟠 Still open",
	resolved: "🟢 Resolved",
	test: "🔔 Hookflare test message",
};

/** M5-15: plain text, no per-platform escaping, at most 1,800 characters with the link kept. */
export function formatAlertMessage(m: AlertMessageInput): string {
	const lines = [
		m.rule ? `${HEADLINE[m.kind]}: ${m.rule}` : HEADLINE[m.kind],
		`Resource: ${m.resourceLabel}`,
		...(m.projectLabel ? [`Project: ${m.projectLabel}`] : []),
		...Object.entries(m.details).map(
			([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
		),
	];
	const tail = m.link ? `\n${m.link}` : "";
	const body = lines.join("\n");
	const room = ALERT_MESSAGE_MAX - tail.length;
	return (body.length > room ? `${body.slice(0, room - 1)}…` : body) + tail;
}

export function channelRequest(
	config: AlertChannelConfig,
	text: string,
): { url: string; body: string } {
	switch (config.type) {
		case "discord":
			return { url: config.url, body: JSON.stringify({ content: text }) };
		case "slack":
			return { url: config.url, body: JSON.stringify({ text }) };
		case "telegram":
			return {
				url: `https://api.telegram.org/bot${config.bot_token}/sendMessage`,
				body: JSON.stringify({
					chat_id: config.chat_id,
					text,
					disable_web_page_preview: true,
				}),
			};
	}
}

/** Defence in depth: the schema already checked this when the channel was saved (M5-10). */
function allowed(config: AlertChannelConfig): boolean {
	return config.type === "telegram"
		? TELEGRAM_TOKEN_RE.test(config.bot_token)
		: isAllowedAlertUrl(config.type, config.url);
}

function scrub(config: AlertChannelConfig, message: string): string {
	const secret = config.type === "telegram" ? config.bot_token : config.url;
	return message.split(secret).join("[redacted]").slice(0, ERROR_MAX);
}

/** Any 2xx is success; everything else (3xx included, never followed) is a failed try. */
export async function sendAlert(
	fetcher: typeof fetch,
	config: AlertChannelConfig,
	text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (!allowed(config)) return { ok: false, error: "url_not_allowed" };
	const { url, body } = channelRequest(config, text);
	try {
		const res = await fetcher(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			redirect: "manual",
			signal: AbortSignal.timeout(ALERT_SEND_TIMEOUT_MS),
		});
		// Response bodies are never stored (spec §6.4).
		await res.body?.cancel();
		return res.status >= 200 && res.status < 300
			? { ok: true }
			: { ok: false, error: `HTTP ${res.status}` };
	} catch (err) {
		return { ok: false, error: scrub(config, String(err)) };
	}
}

export function channelAad(channelId: string): string {
	return `alert_channels.config_enc:${channelId}`;
}

/** M5-9: the whole config is a credential. chat_id is kept in plaintext for display. */
export async function sealChannelConfig(
	env: AppEnv,
	channelId: string,
	config: AlertChannelConfig,
) {
	const json = JSON.stringify(config);
	return {
		configEnc: await encryptSecret(env, json, channelAad(channelId)),
		configFingerprint: await secretFingerprint(json),
		chatId: config.type === "telegram" ? config.chat_id : null,
	};
}

export async function openChannelConfig(
	env: AppEnv,
	channelId: string,
	configEnc: string,
): Promise<AlertChannelConfig> {
	return JSON.parse(
		await decryptSecret(env, configEnc, channelAad(channelId)),
	) as AlertChannelConfig;
}
