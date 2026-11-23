import { describe, expect, it } from "vitest";
import {
	deletePayload,
	loadPayload,
	payloadKey,
	putPayload,
} from "../../src/core/payloads";
import { testDeps } from "../helpers/deps";

describe("payloads", () => {
	it("keys by the UTC date of received_at", () => {
		expect(payloadKey("evt_X", Date.UTC(2026, 0, 2, 23, 59))).toBe(
			"events/2026/01/02/evt_X",
		);
	});

	it("round-trips a body through R2 and returns null when missing", async () => {
		const deps = testDeps();
		const key = payloadKey(`evt_${crypto.randomUUID()}`, Date.now());
		const body = new Uint8Array(70_000).fill(7) as Uint8Array<ArrayBuffer>;
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
		const sha256 = [...digest]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		await putPayload(deps, key, body, {
			sha256,
			contentType: "application/json",
		});

		expect(
			await loadPayload(deps, { r2Key: key, bodyInline: new Uint8Array() }),
		).toEqual(body);
		const obj = await deps.payloads.head(key);
		expect(obj?.httpMetadata?.contentType).toBe("application/json");

		await deletePayload(deps, key);
		expect(
			await loadPayload(deps, { r2Key: key, bodyInline: new Uint8Array() }),
		).toBeNull();
	});

	it("returns the inline body when r2_key is NULL", async () => {
		const inline = new TextEncoder().encode("hi");
		expect(
			await loadPayload(testDeps(), { r2Key: null, bodyInline: inline }),
		).toEqual(inline);
	});

	it("rejects a body whose sha256 does not match", async () => {
		const deps = testDeps();
		await expect(
			putPayload(
				deps,
				"events/bad",
				new Uint8Array([1]) as Uint8Array<ArrayBuffer>,
				{
					sha256: "0".repeat(64),
					contentType: null,
				},
			),
		).rejects.toThrow();
	});
});
