import { describe, expect, it } from "vitest";
import { isDroppedHeader, storableHeaders } from "../../src/core/headers";

describe("storableHeaders", () => {
	it("drops cf-*, proxy-* and hop-by-hop headers and redacts credentials", () => {
		const stored = storableHeaders(
			new Headers({
				"content-type": "application/json",
				"x-github-event": "push",
				authorization: "Bearer leak",
				cookie: "a=b",
				"x-api-key": "k",
				"x-sig": "abc",
				"proxy-authorization": "p",
				"cf-connecting-ip": "1.2.3.4",
				"cf-access-jwt-assertion": "jwt",
				connection: "keep-alive",
				host: "gw.example.com",
			}),
			"x-sig",
		);
		expect(stored).toEqual({
			"content-type": "application/json",
			"x-github-event": "push",
			authorization: "[REDACTED]",
			cookie: "[REDACTED]",
			"x-api-key": "[REDACTED]",
			"x-sig": "[REDACTED]",
		});
	});

	it("works without a source auth header", () => {
		expect(storableHeaders(new Headers({ "x-a": "1" }), null)).toEqual({
			"x-a": "1",
		});
	});
});

describe("isDroppedHeader", () => {
	it.each([
		["CF-Ray", true],
		["proxy-connection", true],
		["transfer-encoding", true],
		["x-github-event", false],
		["authorization", false],
	])("%s → %s", (name, expected) => {
		expect(isDroppedHeader(name)).toBe(expected);
	});
});
