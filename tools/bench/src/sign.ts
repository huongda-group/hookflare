import { createHmac, randomBytes } from "node:crypto";

export const BENCH_HEADER = "x-bench-signature";

export function signHmacHex(secret: string, body: string): string {
	return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

export function randomSecretBase64(bytes = 32): string {
	return randomBytes(bytes).toString("base64");
}

export function makeBody(size: number, seed: string): string {
	const head = '{"pad":"';
	const tail = '"}';
	const fill = Math.max(0, size - head.length - tail.length);
	let pad = "";
	while (pad.length < fill) pad += seed;
	return head + pad.slice(0, fill) + tail;
}
