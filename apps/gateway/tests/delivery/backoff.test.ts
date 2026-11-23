import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type Policy } from "../../src/core/policy";
import {
	infraDelaySeconds,
	parseRetryAfter,
	retryAfterDelaySeconds,
	retryDelaySeconds,
} from "../../src/delivery/backoff";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const low = () => 0;
const high = () => 0.999_999;
const mid = () => 0.5;

describe("retryDelaySeconds", () => {
	it.each([
		[1, 30],
		[2, 60],
		[3, 120],
		[10, 15_360],
		[11, 21_600],
		[20, 21_600],
	])("attempt %i → %i s before jitter", (n, base) => {
		expect(retryDelaySeconds(n, DEFAULT_POLICY, mid)).toBe(base);
		expect(retryDelaySeconds(n, DEFAULT_POLICY, low)).toBe(
			Math.round(base * 0.8),
		);
		expect(retryDelaySeconds(n, DEFAULT_POLICY, high)).toBe(
			Math.round(base * 1.2),
		);
	});

	it("clamps to [1, 43200]", () => {
		const big: Policy = {
			...DEFAULT_POLICY,
			backoffBaseS: 3600,
			backoffMaxS: 43_200,
		};
		expect(retryDelaySeconds(10, big, high)).toBe(43_200);
		const tiny: Policy = { ...DEFAULT_POLICY, backoffBaseS: 1, backoffMaxS: 1 };
		expect(retryDelaySeconds(1, tiny, low)).toBe(1);
	});
});

describe("Retry-After", () => {
	it("parses delta-seconds and HTTP-dates", () => {
		expect(parseRetryAfter("120", NOW)).toBe(120);
		expect(parseRetryAfter(" 7 ", NOW)).toBe(7);
		expect(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90);
		expect(parseRetryAfter(new Date(NOW - 90_000).toUTCString(), NOW)).toBe(
			-90,
		);
	});

	it.each([null, "", "soon", "1.5", "-5", "2026-10-15"])(
		"rejects %j",
		(value) => {
			expect(parseRetryAfter(value, NOW)).toBeNull();
		},
	);

	it("clamps to [1, backoff_max_s]", () => {
		const p: Policy = { ...DEFAULT_POLICY, backoffMaxS: 600 };
		expect(retryAfterDelaySeconds("99999", NOW, p)).toBe(600);
		expect(retryAfterDelaySeconds("0", NOW, p)).toBe(1);
		expect(
			retryAfterDelaySeconds(new Date(NOW - 5000).toUTCString(), NOW, p),
		).toBe(1);
		expect(retryAfterDelaySeconds("garbage", NOW, p)).toBeNull();
	});
});

describe("infraDelaySeconds", () => {
	it("doubles from 60 s and caps at 1 h", () => {
		expect([1, 2, 3, 4, 5, 6, 7, 20].map(infraDelaySeconds)).toEqual([
			60, 120, 240, 480, 960, 1920, 3600, 3600,
		]);
		expect(infraDelaySeconds(0)).toBe(60);
	});
});
