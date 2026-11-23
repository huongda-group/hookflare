import { describe, expect, it } from "vitest";
import {
	hashPassword,
	PBKDF2_ITERATIONS,
	verifyPassword,
} from "../../../src/admin/auth/password";

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) {
		binary += String.fromCharCode(b);
	}
	return btoa(binary);
}

/** Independent PBKDF2-HMAC-SHA256 derivation, so the tests do not lean on the
 * module under test to build their own fixtures. */
async function derive(
	password: string,
	salt: Uint8Array,
	iterations: number,
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
		key,
		256,
	);
	return new Uint8Array(bits);
}

describe("password hashing", () => {
	it("verifies a round-tripped password", async () => {
		const stored = await hashPassword("correct horse battery");
		await expect(verifyPassword("correct horse battery", stored)).resolves.toBe(
			true,
		);
	});

	it("rejects the wrong password", async () => {
		const stored = await hashPassword("correct horse battery");
		await expect(verifyPassword("correct horse batteru", stored)).resolves.toBe(
			false,
		);
	});

	it("uses the documented format and cost parameters", async () => {
		expect(PBKDF2_ITERATIONS).toBe(100_000);
		const stored = await hashPassword("password-123456");
		const [algorithm, iterations, salt, hash] = stored.split("$") as [
			string,
			string,
			string,
			string,
		];
		expect(algorithm).toBe("pbkdf2-sha256");
		expect(iterations).toBe("100000");
		// 16-byte salt and 32-byte key, padded base64.
		expect(salt).toMatch(/^[A-Za-z0-9+/]{22}==$/);
		expect(hash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
	});

	it("never trims or normalizes the password", async () => {
		const password = "  pässwörd 12345 ";
		const stored = await hashPassword(password);
		await expect(verifyPassword(password, stored)).resolves.toBe(true);
		for (const variant of [
			"pässwörd 12345",
			"pässwörd 12345 ",
			"  pässwörd 12345",
			"  PÄSSWÖRD 12345 ",
		]) {
			await expect(verifyPassword(variant, stored)).resolves.toBe(false);
		}
	});

	it("reads the iteration count from the stored hash", async () => {
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const hash = await derive("cheap but correct", salt, 1_000);
		const stored = `pbkdf2-sha256$1000$${toBase64(salt)}$${toBase64(hash)}`;
		expect(stored).toContain("$1000$");
		await expect(verifyPassword("cheap but correct", stored)).resolves.toBe(
			true,
		);
		await expect(verifyPassword("cheap but wrong", stored)).resolves.toBe(
			false,
		);
	});

	it("produces a different hash every time (random salt)", async () => {
		const a = await hashPassword("same password");
		const b = await hashPassword("same password");
		expect(a).not.toBe(b);
		await expect(verifyPassword("same password", a)).resolves.toBe(true);
		await expect(verifyPassword("same password", b)).resolves.toBe(true);
	});

	it("returns false without throwing on a malformed or missing stored value", async () => {
		const malformed: (string | null)[] = [
			null,
			"",
			"   ",
			"garbage",
			"pbkdf2-sha256$100000$only-three-parts",
			"pbkdf2-sha256$100000$AAAA$BBBB$extra",
			"bcrypt$100000$AAAA$BBBB",
			"PBKDF2-SHA256$100000$AAAA$BBBB",
			"pbkdf2-sha256$abc$AAAA$BBBB",
			"pbkdf2-sha256$0$AAAA$BBBB",
			"pbkdf2-sha256$-1$AAAA$BBBB",
			"pbkdf2-sha256$1000$!!!$BBBB",
			"pbkdf2-sha256$1000$AAAA$!!!!",
			"pbkdf2-sha256$999999999$AAAA$BBBB",
		];
		for (const stored of malformed) {
			await expect(verifyPassword("whatever", stored)).resolves.toBe(false);
		}
	});

	it("rejects a well-formed hash whose bytes do not match", async () => {
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const stored = `pbkdf2-sha256$100000$${toBase64(salt)}$${toBase64(
			new Uint8Array(32),
		)}`;
		await expect(verifyPassword("whatever", stored)).resolves.toBe(false);
	});
});
