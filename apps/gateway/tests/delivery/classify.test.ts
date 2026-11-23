import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/core/policy";
import { classifyAttempt, type SendResult } from "../../src/delivery/classify";

const NOW = Date.UTC(2026, 9, 15);
const ctx = (attemptNo: number, maxAttempts = 20) => ({
	attemptNo,
	policy: { ...DEFAULT_POLICY, maxAttempts },
	now: NOW,
	random: () => 0.5,
});
const res = (status: number, retryAfter: string | null = null): SendResult => ({
	kind: "response",
	status,
	retryAfter,
});

describe("classifyAttempt", () => {
	it("2xx is delivered even on the last attempt", () => {
		expect(classifyAttempt(res(204), ctx(20))).toEqual({
			status: "delivered",
			errorKind: null,
			httpStatus: 204,
			error: null,
			delaySeconds: null,
		});
	});

	it.each([
		[408, "http_4xx"],
		[429, "http_4xx"],
		[500, "http_5xx"],
		[503, "http_5xx"],
	] as const)(
		"%i retries before the budget and is dead at it",
		(status, kind) => {
			expect(classifyAttempt(res(status), ctx(1))).toEqual({
				status: "retrying",
				errorKind: kind,
				httpStatus: status,
				error: `HTTP ${status}`,
				delaySeconds: 30,
			});
			expect(classifyAttempt(res(status), ctx(20))).toMatchObject({
				status: "dead",
				delaySeconds: null,
			});
		},
	);

	it.each([
		[301, "http_3xx"],
		[302, "http_3xx"],
		[400, "http_4xx"],
		[404, "http_4xx"],
		[410, "http_4xx"],
	] as const)("%i is failed_final at any attempt", (status, kind) => {
		for (const n of [1, 20]) {
			expect(classifyAttempt(res(status), ctx(n))).toMatchObject({
				status: "failed_final",
				errorKind: kind,
				httpStatus: status,
				delaySeconds: null,
			});
		}
	});

	it("timeout and network errors retry, then go dead", () => {
		const timeout: SendResult = {
			kind: "error",
			error: new DOMException("The operation timed out.", "TimeoutError"),
		};
		const network: SendResult = {
			kind: "error",
			error: new TypeError("Network connection lost."),
		};
		expect(classifyAttempt(timeout, ctx(1))).toMatchObject({
			status: "retrying",
			errorKind: "timeout",
			error: "timeout after 10000 ms",
			httpStatus: null,
		});
		expect(classifyAttempt(network, ctx(1))).toMatchObject({
			status: "retrying",
			errorKind: "network",
			error: "TypeError: Network connection lost.",
		});
		expect(classifyAttempt(timeout, ctx(20)).status).toBe("dead");
		expect(classifyAttempt(network, ctx(20)).status).toBe("dead");
	});

	it("honors Retry-After only for 429", () => {
		expect(classifyAttempt(res(429, "120"), ctx(1)).delaySeconds).toBe(120);
		expect(classifyAttempt(res(503, "120"), ctx(1)).delaySeconds).toBe(30);
		expect(classifyAttempt(res(429, "nope"), ctx(1)).delaySeconds).toBe(30);
	});

	it("is dead when the budget was lowered below the attempt number", () => {
		expect(classifyAttempt(res(503), ctx(6, 3)).status).toBe("dead");
	});
});
