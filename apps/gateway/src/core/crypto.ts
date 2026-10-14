export type SecretsEnv = {
	SECRETS_KEY: string;
	SECRETS_KEY_PREVIOUS?: string;
};

/** SECRETS_KEY / SECRETS_KEY_PREVIOUS is missing or malformed (a config error). */
export class SecretKeyError extends Error {
	override name = "SecretKeyError";
}

/** A stored secret is malformed, tampered, bound to another context, or uses an unknown key. */
export class DecryptError extends Error {
	override name = "DecryptError";
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const KID_LEN = 8;

const keyCache = new Map<string, CryptoKey>();

function bytesToHex(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) {
		out += b.toString(16).padStart(2, "0");
	}
	return out;
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
	const bytes =
		typeof data === "string" ? new TextEncoder().encode(data) : data;
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return bytesToHex(new Uint8Array(digest));
}

function b64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64.trim());
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}

function bytesToB64(bytes: Uint8Array): string {
	let bin = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(bin);
}

export function bytesToB64url(bytes: Uint8Array): string {
	return bytesToB64(bytes)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export function b64urlToBytes(s: string): Uint8Array {
	let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	const pad = b64.length % 4;
	if (pad === 1) {
		throw new Error("invalid base64url string");
	}
	if (pad !== 0) {
		b64 += "=".repeat(4 - pad);
	}
	return b64ToBytes(b64);
}

type LoadedKey = { key: CryptoKey; kid: string };

async function loadKey(b64: string, label: string): Promise<LoadedKey> {
	let raw: Uint8Array;
	try {
		raw = b64ToBytes(b64);
	} catch {
		throw new SecretKeyError(
			`${label} is not valid base64; generate one with: openssl rand -base64 32`,
		);
	}
	if (raw.length !== KEY_BYTES) {
		throw new SecretKeyError(
			`${label} must decode to ${KEY_BYTES} bytes (got ${raw.length}); generate one with: openssl rand -base64 32`,
		);
	}
	const kid = (await sha256Hex(raw)).slice(0, KID_LEN);
	const cacheKey = `${label}:${kid}`;
	const cached = keyCache.get(cacheKey);
	if (cached) {
		return { key: cached, kid };
	}
	const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
	keyCache.set(cacheKey, key);
	return { key, kid };
}

/**
 * Encrypt a secret with AES-256-GCM. `context` is bound as AAD (e.g.
 * `sources.secret_enc:src_...`) so a ciphertext cannot be replayed under a
 * different context. Returns `v1.<kid>.<iv>.<ciphertext>` (base64url parts).
 */
export async function encryptSecret(
	env: SecretsEnv,
	plaintext: string,
	context: string,
): Promise<string> {
	if (!env?.SECRETS_KEY) {
		throw new SecretKeyError(
			"SECRETS_KEY is not configured; generate one with: openssl rand -base64 32",
		);
	}
	const { key, kid } = await loadKey(env.SECRETS_KEY, "SECRETS_KEY");
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const aad = new TextEncoder().encode(context);
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: aad },
		key,
		new TextEncoder().encode(plaintext),
	);
	return `v1.${kid}.${bytesToB64url(iv)}.${bytesToB64url(new Uint8Array(ct))}`;
}

/**
 * Decrypt a `v1.<kid>.<iv>.<ciphertext>` secret. The same `context` used at
 * encryption time is required. SECRETS_KEY_PREVIOUS is accepted for decryption
 * only (key rotation).
 */
export async function decryptSecret(
	env: SecretsEnv,
	stored: string,
	context: string,
): Promise<string> {
	if (!env?.SECRETS_KEY) {
		throw new SecretKeyError("SECRETS_KEY is not configured");
	}
	if (typeof stored !== "string") {
		throw new DecryptError(
			"malformed encrypted secret: expected v1.<kid>.<iv>.<ciphertext>",
		);
	}
	const parts = stored.split(".");
	if (
		parts.length !== 4 ||
		parts[0] !== "v1" ||
		!parts[1] ||
		!parts[2] ||
		!parts[3]
	) {
		throw new DecryptError(
			"malformed encrypted secret: expected v1.<kid>.<iv>.<ciphertext>",
		);
	}
	const [, kid, ivPart, ctPart] = parts as [string, string, string, string];
	let iv: Uint8Array;
	let ct: Uint8Array;
	try {
		iv = b64urlToBytes(ivPart);
		ct = b64urlToBytes(ctPart);
	} catch {
		throw new DecryptError(
			"malformed encrypted secret: iv and ciphertext must be base64url",
		);
	}

	// Load the previous key only when the current one doesn't match, so a bad
	// SECRETS_KEY_PREVIOUS can't break decryption of current-key secrets.
	const current = await loadKey(env.SECRETS_KEY, "SECRETS_KEY");
	let match: LoadedKey | undefined;
	if (current.kid === kid) {
		match = current;
	} else if (env.SECRETS_KEY_PREVIOUS) {
		const previous = await loadKey(
			env.SECRETS_KEY_PREVIOUS,
			"SECRETS_KEY_PREVIOUS",
		);
		if (previous.kid === kid) {
			match = previous;
		}
	}
	if (!match) {
		throw new DecryptError(
			`cannot decrypt secret: unknown key id "${kid}" (not current or previous key)`,
		);
	}
	const aad = new TextEncoder().encode(context);
	try {
		const pt = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv, additionalData: aad },
			match.key,
			ct,
		);
		return new TextDecoder().decode(pt);
	} catch {
		throw new DecryptError(
			"failed to decrypt secret: wrong context, tampered data, or wrong key",
		);
	}
}

/** Stable non-reversible identifier for a secret value (first 8 hex of SHA-256). */
export async function secretFingerprint(plaintext: string): Promise<string> {
	return (await sha256Hex(plaintext)).slice(0, KID_LEN);
}
