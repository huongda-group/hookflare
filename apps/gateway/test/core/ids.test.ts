import { describe, expect, it } from "vitest";
import { ID_PREFIXES, idTimestamp, isId, newId } from "../../src/core/ids";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("ids", () => {
	it("generates <prefix>_<ULID> for every prefix", () => {
		for (const prefix of ID_PREFIXES) {
			const id = newId(prefix);
			expect(id.startsWith(`${prefix}_`)).toBe(true);
			expect(id.slice(prefix.length + 1)).toMatch(ULID_RE);
			expect(isId(id)).toBe(true);
			expect(isId(id, prefix)).toBe(true);
		}
	});

	it("rejects a mismatched prefix", () => {
		const id = newId("evt");
		expect(isId(id, "dlv")).toBe(false);
		expect(isId(id, "evt")).toBe(true);
	});

	it("is strictly increasing over a 10k tight loop", () => {
		const ids: string[] = [];
		for (let i = 0; i < 10_000; i++) {
			ids.push(newId("evt"));
		}
		expect(new Set(ids).size).toBe(ids.length);
		for (let i = 1; i < ids.length; i++) {
			expect((ids[i] ?? "") > (ids[i - 1] ?? "")).toBe(true);
		}
	});

	it("round-trips the timestamp", () => {
		const before = Date.now();
		const id = newId("src");
		const ts = idTimestamp(id);
		const after = Date.now();
		expect(ts).toBeGreaterThanOrEqual(before);
		expect(ts).toBeLessThanOrEqual(after);
	});

	it("rejects invalid ids", () => {
		expect(isId("")).toBe(false);
		expect(isId("evt")).toBe(false);
		expect(isId("evt_")).toBe(false);
		expect(isId("xxx_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
		expect(isId("evt_01ARZ3NDEKTSV4RRFFQ69G5FAV_extra")).toBe(false);
		expect(isId("evt_01ARZ3NDEKTSV4RRFFQ69G5FA*")).toBe(false);
		expect(isId("evt_01arz3ndektsv4rrffq69g5fav")).toBe(false);
		expect(isId("evt_short")).toBe(false);
		expect(isId(null)).toBe(false);
		expect(isId(undefined)).toBe(false);
		expect(isId(42)).toBe(false);
		expect(() => idTimestamp("garbage")).toThrow(/invalid id/);
		expect(() => idTimestamp("evt_short")).toThrow(/invalid id/);
	});

	it("throws on an unknown prefix", () => {
		// @ts-expect-error - intentionally invalid prefix
		expect(() => newId("nope")).toThrow(/invalid id prefix/);
	});

	it("decodes the ULID spec example timestamp", () => {
		expect(idTimestamp("evt_01ARYZ6S41TSV4RRFFQ69G5FAV")).toBe(1469918176385);
	});

	it("stays strictly increasing when the clock moves backwards", () => {
		const t = Date.now() + 60_000;
		const a = newId("evt", t);
		const b = newId("evt", t - 5_000);
		const c = newId("evt", t - 10_000);
		expect(b > a).toBe(true);
		expect(c > b).toBe(true);
		expect(idTimestamp(b)).toBe(t);
	});

	it("rejects ids whose timestamp exceeds 48 bits", () => {
		expect(isId("evt_81ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
		expect(isId("evt_7ZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBe(true);
	});

	it("does not echo untrusted input in the idTimestamp error", () => {
		expect(() => idTimestamp("<script>")).toThrow(/^invalid id$/);
	});
});
