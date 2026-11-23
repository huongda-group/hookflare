import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseJsonc } from "../lib/jsonc.mjs";

describe("parseJsonc", () => {
	it("strips comments and trailing commas but keeps // inside strings", () => {
		const parsed = parseJsonc(
			'{"a": "http://x//y", // c\n "b": [1,2,], /* d */}',
		);
		assert.deepEqual(parsed, { a: "http://x//y", b: [1, 2] });
	});

	it("keeps // inside a string value", () => {
		const parsed = parseJsonc('{"url": "https://example.com//path"}');
		assert.deepEqual(parsed, { url: "https://example.com//path" });
	});
});
