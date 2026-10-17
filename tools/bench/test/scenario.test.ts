import { describe, expect, it } from "vitest";
import { parseScenario, stepSink } from "../src/scenario";

const valid = {
	name: "b1",
	steps: [{ rate_per_s: 25, duration_s: 180 }],
	sources: 40,
	body_bytes: 1024,
	sink: {},
	drain_timeout_s: 1800,
};

describe("parseScenario", () => {
	it("accepts a valid scenario", () => {
		expect(parseScenario(valid).name).toBe("b1");
	});

	it("rejects rate_per_s <= 0", () => {
		expect(() =>
			parseScenario({
				...valid,
				steps: [{ rate_per_s: 0, duration_s: 10 }],
			}),
		).toThrow();
		expect(() =>
			parseScenario({
				...valid,
				steps: [{ rate_per_s: -5, duration_s: 10 }],
			}),
		).toThrow();
	});

	it("accepts a per-step sink and resolves it over the scenario sink", () => {
		const s = parseScenario({
			...valid,
			sink: { delay_ms: 100 },
			steps: [
				{ rate_per_s: 50, duration_s: 10, sink: { fail_pct: 30 } },
				{ rate_per_s: 50, duration_s: 10 },
			],
		});
		expect(stepSink(s, 0)).toEqual({ fail_pct: 30 });
		expect(stepSink(s, 1)).toEqual({ delay_ms: 100 });
	});

	it("rejects an invalid per-step sink", () => {
		expect(() =>
			parseScenario({
				...valid,
				steps: [{ rate_per_s: 1, duration_s: 1, sink: { fail_pct: 101 } }],
			}),
		).toThrow(/fail_pct/);
		expect(() =>
			parseScenario({
				...valid,
				steps: [{ rate_per_s: 1, duration_s: 1, sink: { bogus: 1 } }],
			}),
		).toThrow(/unknown sink key/);
	});

	it("rejects unknown keys", () => {
		expect(() => parseScenario({ ...valid, bogus: 1 })).toThrow();
		expect(() =>
			parseScenario({
				...valid,
				steps: [{ rate_per_s: 10, duration_s: 5, bogus: 1 }],
			}),
		).toThrow();
	});
});
