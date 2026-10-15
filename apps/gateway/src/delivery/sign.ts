import { CREDENTIAL_HEADERS, isDroppedHeader } from "../core/headers";

const REDACTED = "[REDACTED]";

function base64(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

function secretKeyBytes(secret: string): Uint8Array<ArrayBuffer> {
	const bin = atob(
		secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret,
	);
	const out = new Uint8Array(new ArrayBuffer(bin.length));
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Standard Webhooks v1: HMAC-SHA256 over `${id}.${timestamp}.` ‖ body. */
export async function signWebhook(input: {
	id: string;
	timestampSec: number;
	body: Uint8Array<ArrayBufferLike>;
	secret: string;
}): Promise<string> {
	const prefix = new TextEncoder().encode(`${input.id}.${input.timestampSec}.`);
	const message = new Uint8Array(
		new ArrayBuffer(prefix.byteLength + input.body.byteLength),
	);
	message.set(prefix, 0);
	message.set(input.body, prefix.byteLength);
	const key = await crypto.subtle.importKey(
		"raw",
		secretKeyBytes(input.secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return `v1,${base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, message)))}`;
}

function isDenied(name: string, value: string): boolean {
	return (
		isDroppedHeader(name) ||
		CREDENTIAL_HEADERS.includes(name) ||
		name.startsWith("webhook-") ||
		value === REDACTED ||
		name === "content-type"
	);
}

export function buildOutboundHeaders(input: {
	storedHeaders: Record<string, string>;
	contentType: string | null;
	deliveryId: string;
	eventId: string;
	timestampSec: number;
	signature: string;
}): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(input.storedHeaders)) {
		if (!isDenied(name.toLowerCase(), value)) {
			headers.set(name, value);
		}
	}
	if (input.contentType) {
		headers.set("content-type", input.contentType);
	}
	headers.set("webhook-id", input.deliveryId);
	headers.set("webhook-timestamp", String(input.timestampSec));
	headers.set("webhook-signature", input.signature);
	headers.set("x-webhook-event-id", input.eventId);
	headers.set("user-agent", "Hookflare/1");
	return headers;
}
