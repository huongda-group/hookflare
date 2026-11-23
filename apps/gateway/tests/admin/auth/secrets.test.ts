import { describe, expect, it } from "vitest";
import {
	randomToken,
	sha256Hex,
	timingSafeEqual,
} from "../../../src/admin/auth/secrets";

describe("randomToken", () => {
	it("makes a prefixed 32-byte base64url token", () => {
		const token = randomToken("hf_");
		expect(token).toMatch(/^hf_[A-Za-z0-9_-]{43}$/);
	});

	it("defaults to no prefix", () => {
		expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it("never repeats a token", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 50; i++) {
			seen.add(randomToken("hf_"));
		}
		expect(seen.size).toBe(50);
	});
});

describe("sha256Hex", () => {
	it("matches known SHA-256 vectors", async () => {
		await expect(sha256Hex("abc")).resolves.toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		await expect(sha256Hex("")).resolves.toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	it("hashes UTF-8 bytes, not UTF-16 code units", async () => {
		// SHA-256 of the UTF-8 bytes c3 a9 ("é").
		await expect(sha256Hex("é")).resolves.toBe(
			"4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
		);
	});

	it("is lowercase hex and stable", async () => {
		const hex = await sha256Hex("hookflare");
		expect(hex).toMatch(/^[0-9a-f]{64}$/);
		await expect(sha256Hex("hookflare")).resolves.toBe(hex);
	});
});

describe("timingSafeEqual", () => {
	it("is true only for identical strings", () => {
		expect(timingSafeEqual("abc", "abc")).toBe(true);
		expect(timingSafeEqual("abc", "abd")).toBe(false);
		expect(timingSafeEqual("", "")).toBe(true);
	});

	it("is false on a length mismatch", () => {
		expect(timingSafeEqual("a", "ab")).toBe(false);
		expect(timingSafeEqual("abc", "")).toBe(false);
	});

	it("compares UTF-8 bytes", () => {
		expect(timingSafeEqual("pässwörd", "pässwörd")).toBe(true);
		expect(timingSafeEqual("pässwörd", "passwörd")).toBe(false);
		// Same code-point count, different UTF-8 length.
		expect(timingSafeEqual("é", "e")).toBe(false);
	});
});
