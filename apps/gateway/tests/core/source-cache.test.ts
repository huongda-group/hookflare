import { beforeEach, describe, expect, it } from "vitest";
import {
	clearSourceCache,
	getCachedSource,
	SOURCE_CACHE_TTL_MS,
	setCachedSource,
} from "../../src/core/source-cache";

describe("source cache", () => {
	beforeEach(() => clearSourceCache());

	it("distinguishes a miss (undefined) from a cached not-found (null)", () => {
		expect(getCachedSource("src_a", 0)).toBeUndefined();
		setCachedSource("src_a", null, 0);
		expect(getCachedSource("src_a", 1)).toBeNull();
	});

	it("expires entries after the TTL", () => {
		setCachedSource("src_a", null, 1000);
		expect(getCachedSource("src_a", 1000 + SOURCE_CACHE_TTL_MS - 1)).toBeNull();
		expect(
			getCachedSource("src_a", 1000 + SOURCE_CACHE_TTL_MS + 1),
		).toBeUndefined();
	});
});
