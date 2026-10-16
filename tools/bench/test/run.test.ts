import { describe, expect, it } from "vitest";
import { isDrained } from "../src/run";

describe("isDrained", () => {
	it("is true when no pending, queued, or retrying remain", () => {
		expect(isDrained({ pending: 0, queued: 0, retrying: 0 })).toBe(true);
		expect(isDrained({})).toBe(true);
	});

	it("is false when any backlog counter is non-zero", () => {
		expect(isDrained({ pending: 1, queued: 0, retrying: 0 })).toBe(false);
		expect(isDrained({ pending: 0, queued: 2, retrying: 0 })).toBe(false);
		expect(isDrained({ pending: 0, queued: 0, retrying: 5 })).toBe(false);
	});
});
