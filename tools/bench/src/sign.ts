import { createHmac, randomBytes } from "node:crypto";

/** Header carrying the bench HMAC (matches the provisioned source auth_config). */
export const BENCH_HEADER = "x-bench-signature";

/** Hex HMAC-SHA256 of the raw body, as the hmac sources verify it. */
export function signHmacHex(secret: string, body: string): string {
	return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

export function randomSecretBase64(bytes = 32): string {
	return randomBytes(bytes).toString("base64");
}

/**
 * Deterministic JSON body of exactly `size` bytes: a `{"pad":"..."}` object
 * whose padding repeats the seed. ASCII only, so chars and bytes agree.
 */
export function makeBody(size: number, seed: string): string {
	const head = '{"pad":"';
	const tail = '"}';
	const fill = Math.max(0, size - head.length - tail.length);
	let pad = "";
	while (pad.length < fill) pad += seed;
	return head + pad.slice(0, fill) + tail;
}
