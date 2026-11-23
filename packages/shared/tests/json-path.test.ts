import { describe, expect, it } from "vitest";
import { parseJsonPath } from "../src/json-path";

describe("parseJsonPath", () => {
	it.each([
		["$.id", [{ key: "id" }]],
		["$.data.object.id", [{ key: "data" }, { key: "object" }, { key: "id" }]],
		["$.items[0].id", [{ key: "items" }, { index: 0 }, { key: "id" }]],
		["$[2]", [{ index: 2 }]],
		["$.event-id", [{ key: "event-id" }]],
	])("parses %s", (path, expected) => {
		expect(parseJsonPath(path)).toEqual(expected);
	});

	it.each([
		"",
		"$",
		"id",
		"$.",
		"$..id",
		"$.a[",
		"$.a[-1]",
		"$.a[x]",
		"$['a']",
		"$.a b",
		`$.${"a".repeat(300)}`,
	])("rejects %j", (path) => {
		expect(parseJsonPath(path)).toBeNull();
	});
});
