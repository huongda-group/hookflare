import { describe, expect, it } from "vitest";
import { arrivals } from "../src/schedule";

describe("arrivals", () => {
	it("yields 100 times spaced 20 ms apart starting at 0", () => {
		const times = [...arrivals([{ rate_per_s: 50, duration_s: 2 }])];
		expect(times).toHaveLength(100);
		expect(times[0]).toBe(0);
		for (let i = 1; i < times.length; i++) {
			expect(times[i] - times[i - 1]).toBeCloseTo(20, 10);
		}
		expect(times[99]).toBeCloseTo(99 * 20, 10);
	});

	it("continues the second step from the end time of the first", () => {
		const times = [
			...arrivals([
				{ rate_per_s: 10, duration_s: 1 },
				{ rate_per_s: 20, duration_s: 1 },
			]),
		];
		expect(times).toHaveLength(30);
		expect(times[0]).toBe(0);
		expect(times[9]).toBeCloseTo(900, 10);
		expect(times[10]).toBeCloseTo(1000, 10);
		expect(times[29]).toBeCloseTo(1000 + 19 * 50, 10);
	});
});
