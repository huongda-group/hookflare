import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseScenario } from "../src/scenario";

async function loadScenario(name: string): Promise<unknown> {
	const text = await readFile(
		new URL(`../scenarios/${name}.json`, import.meta.url),
		"utf8",
	);
	return JSON.parse(text) as unknown;
}

describe("scenarios", () => {
	it("all five scenario files parse", async () => {
		for (const name of ["b1", "b1-r2", "b2", "b3", "b4"]) {
			expect(parseScenario(await loadScenario(name)).name).toBe(name);
		}
	});

	it("carries the spec §6.3 values", async () => {
		const b1 = parseScenario(await loadScenario("b1"));
		expect(b1.steps.map((s) => s.rate_per_s)).toEqual([25, 50, 100, 200, 400]);
		expect(b1.steps.every((s) => s.duration_s === 180)).toBe(true);
		expect(b1.sources).toBe(40);
		expect(b1.body_bytes).toBe(1024);

		const b1r2 = parseScenario(await loadScenario("b1-r2"));
		expect(b1r2.body_bytes).toBe(102400);

		const b2 = parseScenario(await loadScenario("b2"));
		expect(b2.sources).toBe(1);

		const b3 = parseScenario(await loadScenario("b3"));
		expect(typeof b3.notes).toBe("string");

		const b4 = parseScenario(await loadScenario("b4"));
		expect(b4.sink.fail_pct).toBe(30);
	});
});
