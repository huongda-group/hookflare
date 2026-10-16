import { describe, expect, it } from "vitest";
import { makeBody, signHmacHex } from "../src/sign";

describe("sign", () => {
	it("makes bodies of exactly the requested size", () => {
		expect(makeBody(1024, "seed").length).toBe(1024);
		expect(new TextEncoder().encode(makeBody(1024, "seed")).length).toBe(1024);
	});

	it("signs deterministically as lowercase hex", () => {
		const a = signHmacHex("secret", '{"pad":"x"}');
		expect(a).toBe(signHmacHex("secret", '{"pad":"x"}'));
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(signHmacHex("other", '{"pad":"x"}')).not.toBe(a);
	});
});
