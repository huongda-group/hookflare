import { describe, expect, it } from "vitest";
import { safeNext } from "./next";

describe("safeNext", () => {
	it("keeps a same-origin path and its query string", () => {
		expect(safeNext("/events?x=1")).toBe("/events?x=1");
		expect(safeNext("/projects")).toBe("/projects");
		expect(safeNext("/")).toBe("/");
	});

	it("rejects a scheme, a protocol-relative host, and a backslash path", () => {
		expect(safeNext("https://evil.example")).toBe("/");
		expect(safeNext("http://evil.example/x")).toBe("/");
		expect(safeNext("//evil.example")).toBe("/");
		expect(safeNext("/\\evil")).toBe("/");
		expect(safeNext("javascript:alert(1)")).toBe("/");
	});

	it("rejects anything that is not an absolute path string", () => {
		expect(safeNext(undefined)).toBe("/");
		expect(safeNext(null)).toBe("/");
		expect(safeNext(42)).toBe("/");
		expect(safeNext("")).toBe("/");
		expect(safeNext("events")).toBe("/");
	});
});
