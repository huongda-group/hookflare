import { bytesToB64url } from "../../core/crypto";

const TOKEN_BYTES = 32;

const encoder = new TextEncoder();

/** 32 random bytes, base64url, prefixed — e.g. `hf_<43 chars>` for API tokens. */
export function randomToken(prefix = ""): string {
	const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
	return prefix + bytesToB64url(bytes);
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `value`. */
export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
	let hex = "";
	for (const byte of new Uint8Array(digest)) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}

/**
 * Constant-time comparison over UTF-8 bytes. A length mismatch returns false
 * without calling `crypto.subtle.timingSafeEqual`, which throws on unequal
 * lengths; a length is not secret.
 */
export function timingSafeEqual(a: string, b: string): boolean {
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	return (
		left.byteLength === right.byteLength &&
		crypto.subtle.timingSafeEqual(left, right)
	);
}
