import type { HmacAuthConfig, TokenAuthConfig } from "@hookflare/shared";
import type { AuthType } from "../core/db/schema";

export type VerifyInput = {
	headers: Headers;
	url: URL;
	/** Raw request bytes: signatures are always checked before any parsing. */
	body: Uint8Array<ArrayBuffer>;
	config: Record<string, unknown>;
	secret: string | null;
};

/** Why verification failed: logged only, the caller always answers a bare 401 (spec §6.1). */
export type VerifyFailure =
	| "missing_secret"
	| "missing_header"
	| "bad_prefix"
	| "bad_encoding"
	| "mismatch";

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

export type Verifier = { verify(input: VerifyInput): Promise<VerifyResult> };

const OK: VerifyResult = { ok: true };
const fail = (reason: VerifyFailure): VerifyResult => ({ ok: false, reason });

const HASH = { sha1: "SHA-1", sha256: "SHA-256", sha512: "SHA-512" } as const;
const encoder = new TextEncoder();

function decodeHex(value: string): Uint8Array<ArrayBuffer> | null {
	if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
		return null;
	}
	const out = new Uint8Array(new ArrayBuffer(value.length / 2));
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
	try {
		const bin = atob(value);
		const out = new Uint8Array(new ArrayBuffer(bin.length));
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

/** Constant-time for equal lengths; length itself is not secret here. */
function equalBytes(
	a: Uint8Array<ArrayBufferLike>,
	b: Uint8Array<ArrayBufferLike>,
): boolean {
	return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

const hmacVerifier: Verifier = {
	async verify({ headers, body, config, secret }) {
		const cfg = config as HmacAuthConfig;
		if (!secret) {
			return fail("missing_secret");
		}
		const raw = headers.get(cfg.header)?.trim();
		if (!raw) {
			return fail("missing_header");
		}
		if (cfg.prefix && !raw.startsWith(cfg.prefix)) {
			return fail("bad_prefix");
		}
		const value = cfg.prefix ? raw.slice(cfg.prefix.length) : raw;
		const given =
			cfg.encoding === "hex" ? decodeHex(value) : decodeBase64(value);
		if (!given) {
			return fail("bad_encoding");
		}
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(secret),
			{ name: "HMAC", hash: HASH[cfg.algorithm] },
			false,
			["sign"],
		);
		const expected = new Uint8Array(
			await crypto.subtle.sign("HMAC", key, body),
		);
		return equalBytes(given, expected) ? OK : fail("mismatch");
	},
};

const tokenVerifier: Verifier = {
	async verify({ headers, url, config, secret }) {
		const cfg = config as TokenAuthConfig;
		if (!secret) {
			return fail("missing_secret");
		}
		const given =
			cfg.in === "header"
				? headers.get(cfg.name)
				: url.searchParams.get(cfg.name);
		if (given === null) {
			return fail("missing_header");
		}
		return equalBytes(encoder.encode(given), encoder.encode(secret))
			? OK
			: fail("mismatch");
	},
};

export const verifiers: Record<AuthType, Verifier> = {
	none: { verify: async () => OK },
	hmac: hmacVerifier,
	token: tokenVerifier,
};

/** The header that carries the credential, redacted before the headers are stored. */
export function authHeaderName(
	type: AuthType,
	config: Record<string, unknown>,
): string | null {
	if (type === "hmac") {
		return (config as HmacAuthConfig).header.toLowerCase();
	}
	if (type === "token" && (config as TokenAuthConfig).in === "header") {
		return (config as TokenAuthConfig).name.toLowerCase();
	}
	return null;
}
