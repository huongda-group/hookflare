/**
 * PBKDF2-HMAC-SHA256 password hashing, stored as
 * `pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>` so the cost can rise
 * later without invalidating existing hashes.
 */

/** Workers caps PBKDF2 at 100 000 iterations; the count is also read back from
 * each stored hash, so raising this constant is enough to raise the cost. */
export const PBKDF2_ITERATIONS = 100_000;

const ALGORITHM = "pbkdf2-sha256";
const SALT_BYTES = 16;
const KEY_BYTES = 32;

const encoder = new TextEncoder();

type ParsedHash = {
	iterations: number;
	salt: Uint8Array;
	hash: Uint8Array;
};

/** A well-formed hash that no password can produce: the dummy target keeps a
 * login for an unknown username as expensive as one for a known username. */
const DUMMY_HASH: ParsedHash = {
	iterations: PBKDF2_ITERATIONS,
	salt: new Uint8Array(SALT_BYTES),
	hash: new Uint8Array(KEY_BYTES),
};

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

/** Accepts padded standard base64 and unpadded base64url; returns null instead
 * of throwing so a corrupted stored hash fails closed. */
function fromBase64(value: string): Uint8Array | null {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const pad = normalized.length % 4;
	if (pad === 1) {
		return null;
	}
	const padded = pad === 0 ? normalized : normalized + "=".repeat(4 - pad);
	try {
		const binary = atob(padded);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			out[i] = binary.charCodeAt(i);
		}
		return out;
	} catch {
		return null;
	}
}

function parseHash(stored: string | null): ParsedHash | null {
	if (typeof stored !== "string") {
		return null;
	}
	const parts = stored.split("$");
	if (parts.length !== 4) {
		return null;
	}
	const [algorithm, iterationsRaw, saltB64, hashB64] = parts as [
		string,
		string,
		string,
		string,
	];
	if (algorithm !== ALGORITHM) {
		return null;
	}
	const iterations = Number(iterationsRaw);
	// Above the runtime cap deriveBits can only throw, so treat it as malformed.
	if (
		!Number.isSafeInteger(iterations) ||
		iterations < 1 ||
		iterations > PBKDF2_ITERATIONS
	) {
		return null;
	}
	const salt = fromBase64(saltB64);
	const hash = fromBase64(hashB64);
	if (
		!salt ||
		!hash ||
		salt.length !== SALT_BYTES ||
		hash.length !== KEY_BYTES
	) {
		return null;
	}
	return { iterations, salt, hash };
}

async function derive(
	password: string,
	salt: Uint8Array,
	iterations: number,
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
		key,
		KEY_BYTES * 8,
	);
	return new Uint8Array(bits);
}

/** Constant-time for equal lengths; lengths are not secret here. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/** The password is used verbatim: never trimmed, lowercased, or normalized. */
export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const hash = await derive(password, salt, PBKDF2_ITERATIONS);
	return `${ALGORITHM}$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/**
 * A `null` or malformed `stored` value still runs one PBKDF2 pass (against
 * `DUMMY_HASH`) and returns false, so login timing does not reveal which
 * usernames exist. Never throws.
 */
export async function verifyPassword(
	password: string,
	stored: string | null,
): Promise<boolean> {
	const parsed = parseHash(stored);
	const target = parsed ?? DUMMY_HASH;
	try {
		const derived = await derive(password, target.salt, target.iterations);
		return parsed !== null && equalBytes(derived, target.hash);
	} catch {
		return false;
	}
}
