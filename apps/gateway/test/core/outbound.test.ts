import { describe, expect, it } from "vitest";
import { failureOf } from "../../src/core/outbound";

describe("failureOf", () => {
	it("maps results to error kinds", () => {
		const r = (status: number) => ({
			kind: "response" as const,
			status,
			retryAfter: null,
		});
		expect(failureOf(r(204), 1000)).toBeNull();
		expect(failureOf(r(302), 1000)?.errorKind).toBe("http_3xx");
		expect(failureOf(r(404), 1000)).toEqual({
			errorKind: "http_4xx",
			message: "HTTP 404",
		});
		expect(failureOf(r(503), 1000)?.errorKind).toBe("http_5xx");
		const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
		expect(failureOf({ kind: "error", error: timeout }, 1500)).toEqual({
			errorKind: "timeout",
			message: "timeout after 1500 ms",
		});
		expect(
			failureOf({ kind: "error", error: new TypeError("refused") }, 1),
		).toEqual({
			errorKind: "network",
			message: "TypeError: refused",
		});
	});
});
