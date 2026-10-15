import { describe, expect, it } from "vitest";
import { extractEventId } from "../../src/ingress/event-id";

const enc = (v: unknown) =>
	new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));

describe("extractEventId", () => {
	it("returns null when not configured", () => {
		expect(
			extractEventId("none", null, new Headers(), enc({ id: "x" })),
		).toBeNull();
	});

	it("reads a header", () => {
		expect(
			extractEventId(
				"header",
				"x-event-id",
				new Headers({ "X-Event-Id": " evt_1 " }),
				enc(""),
			),
		).toBe("evt_1");
		expect(
			extractEventId("header", "x-event-id", new Headers(), enc("")),
		).toBeNull();
	});

	it("reads a JSON path with keys and indexes", () => {
		const body = enc({ data: { items: [{ id: "a" }, { id: 42 }] } });
		expect(
			extractEventId("json_path", "$.data.items[0].id", new Headers(), body),
		).toBe("a");
		expect(
			extractEventId("json_path", "$.data.items[1].id", new Headers(), body),
		).toBe("42");
	});

	it.each([
		["missing key", enc({ other: 1 })],
		["non-JSON body", enc("not json")],
		["invalid UTF-8", new Uint8Array([0xff, 0xfe])],
		["object value", enc({ id: { nested: true } })],
		["boolean value", enc({ id: true })],
		["empty string", enc({ id: "" })],
		["too long", enc({ id: "x".repeat(257) })],
		["empty body", new Uint8Array()],
	])("returns null for %s", (_label, body) => {
		expect(extractEventId("json_path", "$.id", new Headers(), body)).toBeNull();
	});

	it("does not read inherited properties", () => {
		expect(
			extractEventId("json_path", "$.constructor", new Headers(), enc({})),
		).toBeNull();
	});
});
