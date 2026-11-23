import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseJsonc, stripJsonc } from "../lib/jsonc.mjs";

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

describe("stripJsonc", () => {
	it("keeps escaped quotes and backslashes inside strings", () => {
		const text =
			'{"a": "say \\"hi\\" // not a comment", "b": "c:\\\\", /* x */}';
		assert.equal(
			stripJsonc(text),
			'{"a": "say \\"hi\\" // not a comment", "b": "c:\\\\" }',
		);
		assert.deepEqual(parseJsonc(text), {
			a: 'say "hi" // not a comment',
			b: "c:\\",
		});
	});

	it("treats a comma before line and block comments then a bracket as trailing", () => {
		assert.deepEqual(parseJsonc("[1, // one\n /* two */ ]"), [1]);
		assert.deepEqual(parseJsonc('{"a": 1, /* c */ "b": 2}'), { a: 1, b: 2 });
	});

	it("rejects invalid JSON after stripping", () => {
		assert.throws(() => parseJsonc("{a: 1}"), SyntaxError);
	});
});
