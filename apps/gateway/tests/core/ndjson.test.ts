import { describe, expect, it } from "vitest";
import { toBytes } from "../../src/core/ndjson";

describe("toBytes", () => {
	it("accepts Uint8Array, ArrayBuffer, and number[]", () => {
		expect([...toBytes(new Uint8Array([1, 2]))]).toEqual([1, 2]);
		expect([...toBytes(new Uint8Array([3]).buffer)]).toEqual([3]);
		expect([...toBytes([4, 5])]).toEqual([4, 5]);
	});

	it("throws on any other shape instead of returning empty bytes", () => {
		expect(() => toBytes("abc")).toThrow(/unsupported blob value/);
		expect(() => toBytes({ a: 1 })).toThrow(/unsupported blob value/);
		expect(() => toBytes(null)).toThrow(/unsupported blob value/);
	});
});
