export const ID_PREFIXES = [
	"prj",
	"src",
	"dst",
	"evt",
	"dlv",
	"att",
	"aud",
	"alr",
	"ach",
	"ant",
	"tst",
	"arb",
	"bkp",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

const PREFIXES = new Set<string>(ID_PREFIXES);

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DECODING: Record<string, number> = {};
for (let i = 0; i < ENCODING.length; i++) {
	DECODING[ENCODING[i]] = i;
}

const ULID_LEN = 26;
const TIME_LEN = 10;
const RAND_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;

// Monotonic state within this isolate. On same-ms (or clock regression) the
// random component is incremented so ids stay strictly increasing.
let lastMs = -1;
const lastRand = new Uint8Array(10);

function encodeTime(ms: number): string {
	let t = BigInt(ms);
	let out = "";
	for (let i = 0; i < TIME_LEN; i++) {
		out = ENCODING[Number(t & 31n)] + out;
		t >>= 5n;
	}
	return out;
}

function encodeRandom(rand: Uint8Array): string {
	let v = 0n;
	for (const b of rand) {
		v = (v << 8n) | BigInt(b);
	}
	let out = "";
	for (let i = 0; i < RAND_LEN; i++) {
		out = ENCODING[Number(v & 31n)] + out;
		v >>= 5n;
	}
	return out;
}

/** Increment a 10-byte big-endian counter in place. Returns false on overflow. */
function increment(rand: Uint8Array): boolean {
	for (let i = rand.length - 1; i >= 0; i--) {
		const cur = rand[i] ?? 0;
		rand[i] = (cur + 1) & 0xff;
		if (rand[i] !== 0) {
			return true;
		}
	}
	return false;
}

function isValidPrefix(prefix: string): prefix is IdPrefix {
	return PREFIXES.has(prefix);
}

function isValidUlid(ulid: string): boolean {
	// First char must be 0-7: anything higher exceeds the 48-bit timestamp.
	if (ulid.length !== ULID_LEN || !/^[0-7]/.test(ulid)) {
		return false;
	}
	for (const ch of ulid) {
		if (DECODING[ch] === undefined) {
			return false;
		}
	}
	return true;
}

/**
 * Generate a new `<prefix>_<ULID>` id, monotonically increasing per isolate.
 * `nowMs` is injectable for tests; production callers omit it.
 */
export function newId(prefix: IdPrefix, nowMs: number = Date.now()): string {
	if (!isValidPrefix(prefix)) {
		throw new Error(
			`invalid id prefix "${prefix}"; expected one of ${ID_PREFIXES.join(", ")}`,
		);
	}
	let now = nowMs;
	if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
		throw new Error("timestamp outside the ULID 48-bit range");
	}
	if (now < lastMs) {
		// Clock moved backwards: hold the last timestamp to stay monotonic.
		now = lastMs;
	}
	if (now === lastMs) {
		if (!increment(lastRand)) {
			// Random overflow on the same ms (practically impossible): step the
			// clock forward 1ms so ordering is still strictly increasing.
			now = lastMs + 1;
			if (now > MAX_TIME) {
				throw new Error("timestamp outside the ULID 48-bit range");
			}
			lastMs = now;
			crypto.getRandomValues(lastRand);
		}
	} else {
		lastMs = now;
		crypto.getRandomValues(lastRand);
	}
	return `${prefix}_${encodeTime(now)}${encodeRandom(lastRand)}`;
}

/** Validate `<prefix>_<ULID>` format, optionally requiring a specific prefix. */
export function isId(value: unknown, prefix?: IdPrefix): boolean {
	if (typeof value !== "string") {
		return false;
	}
	const sep = value.indexOf("_");
	if (sep <= 0 || value.indexOf("_", sep + 1) !== -1) {
		return false;
	}
	const p = value.slice(0, sep);
	const ulid = value.slice(sep + 1);
	if (!isValidPrefix(p) || !isValidUlid(ulid)) {
		return false;
	}
	if (prefix !== undefined && p !== prefix) {
		return false;
	}
	return true;
}

/** Extract the millisecond epoch timestamp embedded in an id. Throws if invalid. */
export function idTimestamp(id: string): number {
	if (!isId(id)) {
		// Do not echo the input: ids often come from untrusted requests.
		throw new Error("invalid id");
	}
	const ulid = id.slice(id.indexOf("_") + 1);
	const timePart = ulid.slice(0, TIME_LEN);
	let ms = 0;
	for (const ch of timePart) {
		ms = ms * 32 + (DECODING[ch] ?? 0);
	}
	return ms;
}
