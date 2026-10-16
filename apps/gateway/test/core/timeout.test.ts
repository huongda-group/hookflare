import { describe, expect, it } from "vitest";
import { withTimeout } from "../../src/core/timeout";

describe("withTimeout", () => {
	it("resolves with the value when fast enough", async () => {
		await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
	});
	it("rejects after ms", async () => {
		await expect(withTimeout(new Promise(() => {}), 10)).rejects.toThrow(
			"timeout after 10 ms",
		);
	});
});
