import { describe, expect, it } from "vitest";
import { readCappedBody } from "../../src/core/body";
import { bodyCap } from "../../src/ingress/body";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(c) {
			for (const ch of chunks) c.enqueue(ch);
			c.close();
		},
	});
}

describe("bodyCap", () => {
	it("defaults to 1 MiB but never exceeds the 64 KiB inline limit", () => {
		expect(bodyCap(null)).toBe(65_536);
		expect(bodyCap(1000)).toBe(1000);
		expect(bodyCap(200_000)).toBe(65_536);
	});
});

describe("readCappedBody", () => {
	it("returns the exact bytes when under the cap", async () => {
		const bytes = new Uint8Array([0x1f, 0x8b, 0x00, 0xff]);
		const r = await readCappedBody(
			new Request("https://x/", { method: "POST", body: bytes }),
			10,
		);
		expect(r).toEqual(bytes);
	});

	it("returns an empty array for an empty or missing body", async () => {
		expect(
			await readCappedBody(new Request("https://x/", { method: "POST" }), 10),
		).toEqual(new Uint8Array());
		expect(
			await readCappedBody(
				new Request("https://x/", { method: "POST", body: "" }),
				10,
			),
		).toEqual(new Uint8Array());
	});

	it("accepts exactly cap bytes and rejects cap + 1", async () => {
		expect(
			await readCappedBody(
				new Request("https://x/", { method: "POST", body: "x".repeat(10) }),
				10,
			),
		).toHaveLength(10);
		expect(
			await readCappedBody(
				new Request("https://x/", { method: "POST", body: "x".repeat(11) }),
				10,
			),
		).toBeNull();
	});

	it("rejects early on a too-large Content-Length", async () => {
		const req = new Request("https://x/", {
			method: "POST",
			body: "x",
			headers: { "content-length": "999999" },
		});
		expect(await readCappedBody(req, 10)).toBeNull();
	});

	it("stops reading a stream that exceeds the cap without a Content-Length", async () => {
		const chunk = new Uint8Array(6);
		const req = new Request("https://x/", {
			method: "POST",
			body: streamOf([chunk, chunk, chunk]),
			duplex: "half",
		} as RequestInit);
		expect(await readCappedBody(req, 10)).toBeNull();
	});
});
