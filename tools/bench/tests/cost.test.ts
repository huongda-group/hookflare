import { describe, expect, it } from "vitest";
import {
	D1_ROWS_PER_INSERT,
	estimateScenario,
	estimateSeed,
	expectedAttempts,
	formatEstimate,
	PRICING,
} from "../src/cost";
import { parseScenario } from "../src/scenario";

const base = {
	name: "t",
	steps: [{ rate_per_s: 10, duration_s: 100 }],
	sources: 1,
	body_bytes: 1024,
	sink: {},
	drain_timeout_s: 60,
};

describe("expectedAttempts", () => {
	it("sums the geometric series of failures up to max_attempts", () => {
		expect(expectedAttempts(0)).toBe(1);
		expect(expectedAttempts(0.5, 3)).toBeCloseTo(1.75);
		expect(expectedAttempts(1, 20)).toBe(20);
		expect(expectedAttempts(0.3)).toBeCloseTo(1 / 0.7, 6);
	});
});

describe("estimateScenario", () => {
	it("counts per-request operations for a healthy sink", () => {
		const e = estimateScenario(parseScenario(base));
		expect(e.requests).toBe(1000);
		expect(e.attempts).toBe(1000);
		// ingress + consumer + sink, one each per request
		expect(e.workers_requests).toBe(3000);
		// write + read + delete per message
		expect(e.queue_ops).toBe(3000);
		expect(e.d1_rows_written).toBe(1000 * (12 + 9));
		expect(e.d1_rows_read).toBe(1000 * (3 + 5));
		expect(e.do_requests).toBe(2000);
		expect(e.r2_class_a).toBe(0);
		expect(e.r2_class_b).toBe(0);
		expect(e.usd.workers).toBeCloseTo(
			(3000 / 1e6) * PRICING.workersPerMillionRequests,
			9,
		);
		expect(e.usd.total).toBeCloseTo(
			e.usd.workers +
				e.usd.queues +
				e.usd.d1_write +
				e.usd.d1_read +
				e.usd.durable_objects +
				e.usd.r2,
			9,
		);
	});

	it("applies each step's sink failure rate and R2 for payloads above 64 KB", () => {
		const e = estimateScenario(
			parseScenario({
				...base,
				body_bytes: 100 * 1024,
				steps: [
					{ rate_per_s: 10, duration_s: 100, sink: { fail_pct: 50 } },
					{ rate_per_s: 10, duration_s: 100 },
				],
			}),
			{ maxAttempts: 3 },
		);
		expect(e.requests).toBe(2000);
		expect(e.attempts).toBeCloseTo(1000 * 1.75 + 1000);
		expect(e.queue_ops).toBeCloseTo(3 * 2750);
		expect(e.r2_class_a).toBe(2000);
		expect(e.r2_class_b).toBeCloseTo(2750);
	});

	it("formats a report with the pricing caveat", () => {
		const text = formatEstimate(estimateScenario(parseScenario(base)));
		expect(text).toMatch(/requests\s+1,000/);
		expect(text).toMatch(/verify against current pricing/i);
		expect(text).toMatch(/\$/);
	});
});

describe("estimateSeed", () => {
	it("counts index rows per inserted row", () => {
		const e = estimateSeed({
			webhook_events: 100,
			deliveries: 100,
			delivery_attempts: 200,
		});
		expect(e.d1_rows_written).toBe(
			100 * D1_ROWS_PER_INSERT.webhook_events +
				100 * D1_ROWS_PER_INSERT.deliveries +
				200 * D1_ROWS_PER_INSERT.delivery_attempts,
		);
		expect(e.usd).toBeCloseTo(
			(e.d1_rows_written / 1e6) * PRICING.d1PerMillionRowsWritten,
			9,
		);
	});
});
