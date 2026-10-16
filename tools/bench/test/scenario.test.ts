import { describe, expect, it } from "vitest";
import { parseScenario } from "../src/scenario";

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
