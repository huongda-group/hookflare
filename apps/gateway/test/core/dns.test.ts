import { describe, expect, it, vi } from "vitest";
import { createDohResolver, DnsError } from "../../src/core/dns";

function dohFetch(
	answers: Record<string, { Status: number; Answer?: unknown[] }>,
) {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		const type = url.searchParams.get("type") ?? "";
		const body = answers[type];
		if (!body) {
			return new Response("no", { status: 500 });
		}
		return Response.json(body);
	}) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("createDohResolver", () => {
	it("queries Cloudflare DoH for A and AAAA with the JSON accept header", async () => {
		const f = dohFetch({
			A: { Status: 0, Answer: [] },
			AAAA: { Status: 0, Answer: [] },
		});
		await createDohResolver(f)("example.com");
		expect(f).toHaveBeenCalledTimes(2);
		const [url, init] = f.mock.calls[0] as [string, RequestInit];
		expect(url).toMatch(
			/^https:\/\/cloudflare-dns\.com\/dns-query\?name=example\.com&type=(A|AAAA)$/,
		);
		expect(new Headers(init.headers).get("accept")).toBe(
			"application/dns-json",
		);
	});

	it("returns A and AAAA addresses and skips CNAME records", async () => {
		const f = dohFetch({
			A: {
				Status: 0,
				Answer: [
					{ type: 5, data: "alias.example.net." },
					{ type: 1, data: "93.184.216.34" },
				],
			},
			AAAA: { Status: 0, Answer: [{ type: 28, data: "2606:2800:220:1::1" }] },
		});
		await expect(createDohResolver(f)("example.com")).resolves.toEqual([
			"93.184.216.34",
			"2606:2800:220:1::1",
		]);
	});

	it("returns [] for NXDOMAIN", async () => {
		const f = dohFetch({ A: { Status: 3 }, AAAA: { Status: 3 } });
		await expect(createDohResolver(f)("nope.example")).resolves.toEqual([]);
	});

	it("throws DnsError on SERVFAIL, HTTP errors, and network errors", async () => {
		await expect(
			createDohResolver(dohFetch({ A: { Status: 2 }, AAAA: { Status: 0 } }))(
				"x.example",
			),
		).rejects.toBeInstanceOf(DnsError);
		await expect(
			createDohResolver(dohFetch({}))("x.example"),
		).rejects.toBeInstanceOf(DnsError);
		const broken = vi.fn(async () => {
			throw new TypeError("network down");
		}) as unknown as typeof fetch;
		await expect(createDohResolver(broken)("x.example")).rejects.toBeInstanceOf(
			DnsError,
		);
	});
});
