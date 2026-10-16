import { describe, expect, it } from "vitest";
import { percentiles, summarize } from "../src/stats";

describe("percentiles", () => {
	it("uses nearest rank", () => {
		const latencies = Array.from({ length: 100 }, (_, i) => i + 1);
		expect(percentiles(latencies, [50, 99])).toEqual({ p50: 50, p99: 99 });
	});
});

describe("summarize", () => {
	it("counts statuses as strings", () => {
		const summary = summarize([
			{ status: 202, ms: 10 },
			{ status: 202, ms: 20 },
			{ status: 429, ms: 5 },
		]);
		expect(summary.count).toBe(3);
		expect(summary.by_status).toEqual({ "202": 2, "429": 1 });
		expect(summary.by_status["202"]).toBe(2);
	});
});
