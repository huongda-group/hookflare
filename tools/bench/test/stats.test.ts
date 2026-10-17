import { describe, expect, it } from "vitest";
import {
	actualRate,
	percentiles,
	type SendResult,
	summarize,
} from "../src/stats";

function http(
	status: number,
	ms: number,
	sent_at = 0,
	late_ms = 0,
): SendResult {
	return { status, kind: "http", ms, late_ms, sent_at };
}

describe("percentiles", () => {
	it("uses nearest rank", () => {
		const latencies = Array.from({ length: 100 }, (_, i) => i + 1);
		expect(percentiles(latencies, [50, 99])).toEqual({ p50: 50, p99: 99 });
	});
});

describe("actualRate", () => {
	it("divides intervals by the first-to-last span", () => {
		expect(actualRate([0, 100, 200, 300, 400])).toBe(10);
		expect(actualRate([0])).toBeNull();
		expect(actualRate([5, 5])).toBeNull();
	});
});

describe("summarize", () => {
	it("counts statuses as strings", () => {
		const summary = summarize([http(202, 10), http(202, 20), http(429, 5)]);
		expect(summary.count).toBe(3);
		expect(summary.by_status).toEqual({ "202": 2, "429": 1 });
	});

	it("separates timeouts, network errors, and HTTP error classes", () => {
		const summary = summarize([
			http(202, 1),
			http(503, 1),
			http(500, 1),
			http(404, 1),
			{ status: 0, kind: "timeout", ms: 30000, late_ms: 0, sent_at: 0 },
			{ status: 0, kind: "network", ms: 3, late_ms: 0, sent_at: 0 },
		]);
		expect(summary.by_status).toEqual({
			"202": 1,
			"503": 1,
			"500": 1,
			"404": 1,
			timeout: 1,
			network: 1,
		});
		expect(summary.errors).toEqual({
			timeout: 1,
			network: 1,
			http_4xx: 1,
			http_5xx: 2,
		});
	});

	it("reports scheduled vs actual rate and the lateness distribution", () => {
		const results = Array.from({ length: 11 }, (_, i) =>
			// scheduled every 100 ms, actually sent every 200 ms
			http(202, 10, i * 200, i * 100),
		);
		const summary = summarize(results, 10);
		expect(summary.scheduled_rate_per_s).toBe(10);
		expect(summary.actual_rate_per_s).toBe(5);
		expect(summary.lateness_ms).toEqual({ p50: 500, p99: 1000, max: 1000 });
	});
});
