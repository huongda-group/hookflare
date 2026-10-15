import { describe, expect, it } from "vitest";
import { classifyError, classifyResponse } from "../../src/delivery/classify";

describe("classifyResponse", () => {
	it.each([
		[200, "delivered", null, null],
		[204, "delivered", null, null],
		[301, "failed_final", "http_3xx", "HTTP 301"],
		[404, "failed_final", "http_4xx", "HTTP 404"],
		[503, "failed_final", "http_5xx", "HTTP 503"],
	])("%i → %s", (code, status, errorKind, error) => {
		expect(classifyResponse(code)).toEqual({
			status,
			errorKind,
			httpStatus: code,
			error,
		});
	});
});

describe("classifyError", () => {
	it("maps an abort-signal timeout to timeout", () => {
		const err = new DOMException("The operation timed out.", "TimeoutError");
		expect(classifyError(err, 10000)).toEqual({
			status: "failed_final",
			errorKind: "timeout",
			httpStatus: null,
			error: "timeout after 10000 ms",
		});
	});

	it("maps anything else to network with name and message", () => {
		expect(
			classifyError(new TypeError("Network connection lost."), 10000),
		).toEqual({
			status: "failed_final",
			errorKind: "network",
			httpStatus: null,
			error: "TypeError: Network connection lost.",
		});
		expect(classifyError("boom", 10000).errorKind).toBe("network");
	});
});
