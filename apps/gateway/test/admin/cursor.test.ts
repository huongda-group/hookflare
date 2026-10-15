import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/admin/cursor";

describe("cursor", () => {
	it("round-trips", () => {
		const c = encodeCursor(1_700_000_000_000, "evt_01J0");
		expect(decodeCursor(c)).toEqual({ at: 1_700_000_000_000, id: "evt_01J0" });
	});

	it("returns null when absent and invalid when garbled", () => {
		expect(decodeCursor(undefined)).toBeNull();
		expect(decodeCursor("not-base64-json")).toBe("invalid");
		expect(decodeCursor(btoa('{"at":"x","id":1}'))).toBe("invalid");
	});
});
