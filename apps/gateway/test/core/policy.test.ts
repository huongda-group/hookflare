import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, resolvePolicy } from "../../src/core/policy";

const none = {
	timeoutMs: null,
	maxAttempts: null,
	backoffBaseS: null,
	backoffMaxS: null,
};

describe("resolvePolicy", () => {
	it("uses the given defaults for unset fields", () => {
		const defaults = { ...DEFAULT_POLICY, maxAttempts: 3, timeoutMs: 5000 };
		expect(resolvePolicy(none, defaults)).toEqual(defaults);
	});

	it("lets a destination field win over the defaults", () => {
		expect(
			resolvePolicy({ ...none, maxAttempts: 7 }, DEFAULT_POLICY).maxAttempts,
		).toBe(7);
	});

	it("keeps DEFAULT_POLICY at the M2 values", () => {
		expect(DEFAULT_POLICY).toEqual({
			timeoutMs: 10_000,
			maxAttempts: 20,
			backoffBaseS: 30,
			backoffMaxS: 21_600,
		});
	});

	it("clamps backoff_max_s up to backoff_base_s", () => {
		const defaults = { ...DEFAULT_POLICY, backoffMaxS: 60 };
		const p = resolvePolicy({ ...none, backoffBaseS: 600 }, defaults);
		expect(p.backoffBaseS).toBe(600);
		expect(p.backoffMaxS).toBe(600);
	});
});
