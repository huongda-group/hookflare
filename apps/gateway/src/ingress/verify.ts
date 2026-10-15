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

export type Verifier = { verify(input: VerifyInput): Promise<boolean> };

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
		const raw = headers.get(cfg.header)?.trim();
		if (!secret || !raw) {
			return false;
		}
		if (cfg.prefix && !raw.startsWith(cfg.prefix)) {
			return false;
		}
		const value = cfg.prefix ? raw.slice(cfg.prefix.length) : raw;
		const given =
			cfg.encoding === "hex" ? decodeHex(value) : decodeBase64(value);
		if (!given) {
			return false;
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
		return equalBytes(given, expected);
	},
};

const tokenVerifier: Verifier = {
	async verify({ headers, url, config, secret }) {
		const cfg = config as TokenAuthConfig;
		const given =
			cfg.in === "header"
				? headers.get(cfg.name)
				: url.searchParams.get(cfg.name);
		if (!secret || given === null) {
			return false;
		}
		return equalBytes(encoder.encode(given), encoder.encode(secret));
	},
};

export const verifiers: Record<AuthType, Verifier> = {
	none: { verify: async () => true },
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
