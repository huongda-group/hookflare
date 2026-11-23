import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, it } from "node:test";

describe("scripts/lib coverage completeness", () => {
	it("imports every library module", async () => {
		const dir = new URL("../lib/", import.meta.url);
		const files = readdirSync(dir).filter((f) => f.endsWith(".mjs"));
		assert.ok(files.length > 0);
		for (const file of files) {
			await import(new URL(file, dir).href);
		}
	});
});
