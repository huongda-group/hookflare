import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, resolvePolicy } from "../../src/core/policy";

describe("resolvePolicy", () => {
	it("uses the defaults for NULL columns", () => {
		expect(
			resolvePolicy({
				timeoutMs: null,
				maxAttempts: null,
				backoffBaseS: null,
				backoffMaxS: null,
			}),
		).toEqual({
			timeoutMs: 10_000,
			maxAttempts: 20,
			backoffBaseS: 30,
			backoffMaxS: 21_600,
		});
		expect(DEFAULT_POLICY.maxAttempts).toBe(20);
	});

	it("keeps set columns", () => {
		expect(
			resolvePolicy({
				timeoutMs: 5000,
				maxAttempts: 3,
				backoffBaseS: 10,
				backoffMaxS: 60,
			}),
		).toEqual({
			timeoutMs: 5000,
			maxAttempts: 3,
			backoffBaseS: 10,
			backoffMaxS: 60,
		});
	});
});
