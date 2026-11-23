import { bytesToB64url } from "../../core/crypto";

const TOKEN_BYTES = 32;

const encoder = new TextEncoder();

export function randomToken(prefix = ""): string {
	const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
	return prefix + bytesToB64url(bytes);
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
	let hex = "";
	for (const byte of new Uint8Array(digest)) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}

export function timingSafeEqual(a: string, b: string): boolean {
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	return (
		left.byteLength === right.byteLength &&
		crypto.subtle.timingSafeEqual(left, right)
	);
}
