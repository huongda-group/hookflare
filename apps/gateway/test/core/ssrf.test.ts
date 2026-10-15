import { beforeEach, describe, expect, it, vi } from "vitest";
import { DnsError } from "../../src/core/dns";
import {
	checkUrl,
	clearSsrfCache,
	isBlockedAddress,
} from "../../src/core/ssrf";

const PUBLIC = "93.184.216.34";

function deps(addresses: string[] | Error, now = 1_000_000) {
	return {
		resolveDns: vi.fn(async () => {
			if (addresses instanceof Error) {
				throw addresses;
			}
			return addresses;
		}),
		now: () => now,
	};
}

beforeEach(() => clearSsrfCache());

describe("checkUrl static checks", () => {
	it.each([
		["not a url", "invalid_url"],
		["http://example.com/hook", "scheme_not_https"],
		["https://user:pass@example.com/", "userinfo_not_allowed"],
		["https://127.0.0.1/", "ip_literal"],
		["https://2130706433/", "ip_literal"], // decimal form of 127.0.0.1
		["https://0x7f.1/", "ip_literal"], // hex short form
		["https://[::1]/", "ip_literal"],
		["https://localhost/", "internal_hostname"],
		["https://api.localhost/", "internal_hostname"],
		["https://printer.local/", "internal_hostname"],
		["https://db.internal/", "internal_hostname"],
		["https://metadata.google.internal/", "internal_hostname"],
		["https://metadata/", "internal_hostname"],
		["https://instance-data/", "internal_hostname"],
		["https://LOCALHOST./", "internal_hostname"],
	])("%s → %s", async (url, reason) => {
		const d = deps([PUBLIC]);
		await expect(checkUrl(url, d)).resolves.toEqual({ ok: false, reason });
		expect(d.resolveDns).not.toHaveBeenCalled();
	});
});

describe("checkUrl DNS checks", () => {
	it("allows a host that resolves only to public addresses", async () => {
		await expect(
			checkUrl(
				"https://example.com/hook",
				deps([PUBLIC, "2606:2800:220:1::1"]),
			),
		).resolves.toEqual({ ok: true });
	});

	it("blocks when any resolved address is private", async () => {
		await expect(
			checkUrl("https://example.com/", deps([PUBLIC, "10.1.2.3"])),
		).resolves.toEqual({
			ok: false,
			reason: "private_address",
		});
	});

	it("blocks a host with no records (incl. NXDOMAIN)", async () => {
		await expect(checkUrl("https://example.com/", deps([]))).resolves.toEqual({
			ok: false,
			reason: "no_records",
		});
	});

	it("propagates DnsError and does not cache it", async () => {
		await expect(
			checkUrl("https://example.com/", deps(new DnsError("servfail"))),
		).rejects.toBeInstanceOf(DnsError);
		const ok = deps([PUBLIC]);
		await expect(checkUrl("https://example.com/", ok)).resolves.toEqual({
			ok: true,
		});
		expect(ok.resolveDns).toHaveBeenCalledTimes(1);
	});

	it("caches results per hostname for 60 seconds", async () => {
		const first = deps([PUBLIC], 0);
		await checkUrl("https://example.com/a", first);
		const within = deps(["10.0.0.1"], 59_999);
		await expect(checkUrl("https://example.com/b", within)).resolves.toEqual({
			ok: true,
		});
		expect(within.resolveDns).not.toHaveBeenCalled();
		const after = deps(["10.0.0.1"], 60_001);
		await expect(checkUrl("https://example.com/c", after)).resolves.toEqual({
			ok: false,
			reason: "private_address",
		});
	});
});

describe("isBlockedAddress", () => {
	it.each([
		"0.1.2.3",
		"10.0.0.1",
		"100.64.0.1",
		"127.0.0.1",
		"169.254.169.254",
		"172.16.0.1",
		"172.31.255.255",
		"192.0.0.8",
		"192.168.1.1",
		"198.18.0.1",
		"224.0.0.1",
		"240.0.0.1",
		"255.255.255.255",
		"::",
		"::1",
		"fc00::1",
		"fd12:3456::1",
		"fe80::1",
		"ff02::1",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"64:ff9b::a00:1", // NAT64 of 10.0.0.1
		"fe80::1%eth0",
		"not-an-ip",
	])("blocks %s", (addr) => {
		expect(isBlockedAddress(addr)).toBe(true);
	});

	it.each([
		"93.184.216.34",
		"172.32.0.1",
		"100.128.0.1",
		"2606:2800:220:1::1",
		"::ffff:93.184.216.34",
		"64:ff9b::5db8:d822",
	])("allows %s", (addr) => {
		expect(isBlockedAddress(addr)).toBe(false);
	});
});
