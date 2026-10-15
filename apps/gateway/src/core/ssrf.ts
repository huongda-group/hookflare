import type { ResolveDns } from "./dns";

export type SsrfResult = { ok: true } | { ok: false; reason: string };
export type SsrfDeps = { resolveDns: ResolveDns; now: () => number };

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1000;
const cache = new Map<string, { result: SsrfResult; expiresAt: number }>();

/** Tests only. */
export function clearSsrfCache(): void {
	cache.clear();
}

const BLOCKED_HOSTS = new Set([
	"localhost",
	"metadata.google.internal",
	"metadata",
	"instance-data",
]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal"];

const V4_BLOCKED: Array<[string, number]> = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];
const V6_BLOCKED: Array<[string, number]> = [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
];
/** Prefixes whose last 32 bits embed an IPv4 address that is checked instead. */
const V6_EMBEDDED_V4: Array<[string, number]> = [
	["::ffff:0:0", 96],
	["64:ff9b::", 96],
];

function blocked(reason: string): SsrfResult {
	return { ok: false, reason };
}

function parseIPv4(s: string): number | null {
	const parts = s.split(".");
	if (parts.length !== 4) {
		return null;
	}
	let n = 0;
	for (const p of parts) {
		if (!/^\d{1,3}$/.test(p) || Number(p) > 255) {
			return null;
		}
		n = n * 256 + Number(p);
	}
	return n;
}

/** Eight 16-bit groups, or null. Accepts `::` and a trailing dotted IPv4. */
function parseIPv6(input: string): number[] | null {
	let s = input.toLowerCase();
	const zone = s.indexOf("%");
	if (zone !== -1) {
		s = s.slice(0, zone);
	}
	const lastColon = s.lastIndexOf(":");
	if (lastColon === -1) {
		return null;
	}
	const tail = s.slice(lastColon + 1);
	if (tail.includes(".")) {
		const v4 = parseIPv4(tail);
		if (v4 === null) {
			return null;
		}
		s = `${s.slice(0, lastColon + 1)}${Math.floor(v4 / 0x10000).toString(16)}:${(v4 % 0x10000).toString(16)}`;
	}
	const halves = s.split("::");
	if (halves.length > 2) {
		return null;
	}
	const groups = (part: string) =>
		part === ""
			? []
			: part
					.split(":")
					.map((g) =>
						/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN,
					);
	const head = groups(halves[0] ?? "");
	const rest = halves.length === 2 ? groups(halves[1] ?? "") : [];
	if ([...head, ...rest].some(Number.isNaN)) {
		return null;
	}
	if (halves.length === 1) {
		return head.length === 8 ? head : null;
	}
	const fill = 8 - head.length - rest.length;
	return fill < 1
		? null
		: [...head, ...new Array<number>(fill).fill(0), ...rest];
}

function inV4(addr: number, base: string, bits: number): boolean {
	const size = 2 ** (32 - bits);
	return (
		Math.floor(addr / size) === Math.floor((parseIPv4(base) as number) / size)
	);
}

function inV6(addr: number[], base: string, bits: number): boolean {
	const b = parseIPv6(base) as number[];
	let left = bits;
	for (let i = 0; i < 8 && left > 0; i++) {
		const take = Math.min(16, left);
		const mask = (0xffff << (16 - take)) & 0xffff;
		if (((addr[i] as number) & mask) !== ((b[i] as number) & mask)) {
			return false;
		}
		left -= take;
	}
	return true;
}

function isBlockedV4(addr: number): boolean {
	return V4_BLOCKED.some(([base, bits]) => inV4(addr, base, bits));
}

/** True if the address is private/reserved, or cannot be parsed (fail closed). */
export function isBlockedAddress(address: string): boolean {
	const v4 = parseIPv4(address);
	if (v4 !== null) {
		return isBlockedV4(v4);
	}
	const v6 = parseIPv6(address);
	if (v6 === null) {
		return true;
	}
	for (const [base, bits] of V6_EMBEDDED_V4) {
		if (inV6(v6, base, bits)) {
			return isBlockedV4((v6[6] as number) * 0x10000 + (v6[7] as number));
		}
	}
	return V6_BLOCKED.some(([base, bits]) => inV6(v6, base, bits));
}

/**
 * §8: static URL checks, then DoH (A + AAAA); blocked if any address is
 * private. Results are cached per hostname for 60 s; DnsError is not cached.
 */
export async function checkUrl(
	rawUrl: string,
	deps: SsrfDeps,
): Promise<SsrfResult> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return blocked("invalid_url");
	}
	if (url.protocol !== "https:") {
		return blocked("scheme_not_https");
	}
	if (url.username !== "" || url.password !== "") {
		return blocked("userinfo_not_allowed");
	}
	// URL normalizes decimal/hex/short IPv4 forms into dotted quads.
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (host.startsWith("[") || parseIPv4(host) !== null) {
		return blocked("ip_literal");
	}
	if (
		BLOCKED_HOSTS.has(host) ||
		BLOCKED_SUFFIXES.some((s) => host.endsWith(s))
	) {
		return blocked("internal_hostname");
	}

	const hit = cache.get(host);
	if (hit && hit.expiresAt > deps.now()) {
		return hit.result;
	}
	const addresses = await deps.resolveDns(host);
	const result =
		addresses.length === 0
			? blocked("no_records")
			: addresses.some(isBlockedAddress)
				? blocked("private_address")
				: ({ ok: true } as const);
	if (cache.size >= CACHE_MAX_ENTRIES) {
		cache.delete(cache.keys().next().value as string);
	}
	cache.set(host, { result, expiresAt: deps.now() + CACHE_TTL_MS });
	return result;
}
