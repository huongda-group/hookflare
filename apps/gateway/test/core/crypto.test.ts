import { describe, expect, it } from "vitest";
import type { SecretsEnv } from "../../src/core/crypto";
import {
	DecryptError,
	decryptSecret,
	encryptSecret,
	SecretKeyError,
	secretFingerprint,
} from "../../src/core/crypto";

function randomKeyB64(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let bin = "";
	for (const b of bytes) {
		bin += String.fromCharCode(b);
	}
	return btoa(bin);
}

function tamper(stored: string): string {
	const parts = stored.split(".");
	const ct = parts[3] ?? "";
	const flipped = ct[0] === "A" ? "B" : "A";
	parts[3] = flipped + ct.slice(1);
	return parts.join(".");
}

describe("crypto", () => {
	it("round-trips and uses the v1.<kid>.<iv>.<ciphertext> format", async () => {
		const env: SecretsEnv = { SECRETS_KEY: randomKeyB64() };
		const stored = await encryptSecret(
			env,
			"s3cr3t-value",
			"sources.secret_enc:src_1",
		);
		expect(stored).toMatch(/^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		await expect(
			decryptSecret(env, stored, "sources.secret_enc:src_1"),
		).resolves.toBe("s3cr3t-value");
	});

	it("encrypts the same plaintext to different ciphertexts (random IV)", async () => {
		const env: SecretsEnv = { SECRETS_KEY: randomKeyB64() };
		const a = await encryptSecret(env, "same", "ctx");
		const b = await encryptSecret(env, "same", "ctx");
		expect(a).not.toBe(b);
	});

	it("fails with the wrong context", async () => {
		const env: SecretsEnv = { SECRETS_KEY: randomKeyB64() };
		const stored = await encryptSecret(env, "s3cr3t", "ctx-a");
		await expect(decryptSecret(env, stored, "ctx-b")).rejects.toThrow(
			/wrong context|failed to decrypt/i,
		);
	});

	it("fails on tampered ciphertext", async () => {
		const env: SecretsEnv = { SECRETS_KEY: randomKeyB64() };
		const stored = await encryptSecret(env, "s3cr3t", "ctx");
		await expect(decryptSecret(env, tamper(stored), "ctx")).rejects.toThrow(
			/failed to decrypt/i,
		);
	});

	it("decrypts with the previous key after rotation, encrypts with the new one", async () => {
		const oldKey = randomKeyB64();
		const newKey = randomKeyB64();
		const stored = await encryptSecret(
			{ SECRETS_KEY: oldKey },
			"s3cr3t",
			"ctx",
		);
		const rotated: SecretsEnv = {
			SECRETS_KEY: newKey,
			SECRETS_KEY_PREVIOUS: oldKey,
		};
		await expect(decryptSecret(rotated, stored, "ctx")).resolves.toBe("s3cr3t");
		const fresh = await encryptSecret(rotated, "s3cr3t", "ctx");
		expect(fresh.split(".")[1]).not.toBe(stored.split(".")[1]);
		await expect(decryptSecret(rotated, fresh, "ctx")).resolves.toBe("s3cr3t");
		// Old env alone cannot read the new ciphertext.
		await expect(
			decryptSecret({ SECRETS_KEY: oldKey }, fresh, "ctx"),
		).rejects.toThrow(/unknown key id/);
	});

	it("decrypts current-key secrets even if the previous key is malformed", async () => {
		const env: SecretsEnv = { SECRETS_KEY: randomKeyB64() };
		const stored = await encryptSecret(env, "s3cr3t", "ctx");
		await expect(
			decryptSecret(
				{ ...env, SECRETS_KEY_PREVIOUS: "!!!not-base64!!!" },
				stored,
				"ctx",
			),
		).resolves.toBe("s3cr3t");
		// A previous-key ciphertext still surfaces the bad config loudly.
		const other = await encryptSecret(
			{ SECRETS_KEY: randomKeyB64() },
			"s3cr3t",
			"ctx",
		);
		await expect(
			decryptSecret(
				{ ...env, SECRETS_KEY_PREVIOUS: "!!!not-base64!!!" },
				other,
				"ctx",
			),
		).rejects.toBeInstanceOf(SecretKeyError);
	});

	it("fails on an unknown kid", async () => {
		const envA: SecretsEnv = { SECRETS_KEY: randomKeyB64() };
		const envB: SecretsEnv = { SECRETS_KEY: randomKeyB64() };
		const stored = await encryptSecret(envA, "s3cr3t", "ctx");
		await expect(decryptSecret(envB, stored, "ctx")).rejects.toThrow(
			/unknown key id/,
		);
	});

	it("rejects malformed stored values", async () => {
		const env: SecretsEnv = { SECRETS_KEY: randomKeyB64() };
		for (const bad of ["", "v1.only", "v2.abcdef01.eA.eA", "not-a-secret"]) {
			await expect(decryptSecret(env, bad, "ctx")).rejects.toThrow(/malformed/);
		}
	});

	it("fails loudly on a malformed key", async () => {
		await expect(
			encryptSecret({ SECRETS_KEY: "!!!not-base64!!!" }, "x", "ctx"),
		).rejects.toThrow(/SECRETS_KEY.*(base64|openssl)/);
		// Valid base64 but only 16 bytes.
		const short = btoa("0123456789abcdef");
		await expect(
			encryptSecret({ SECRETS_KEY: short }, "x", "ctx"),
		).rejects.toThrow(/SECRETS_KEY.*32 bytes/);
		await expect(
			encryptSecret({ SECRETS_KEY: "" }, "x", "ctx"),
		).rejects.toThrow(/SECRETS_KEY is not configured/);
	});

	it("produces a stable fingerprint", async () => {
		const a = await secretFingerprint("s3cr3t-value");
		const b = await secretFingerprint("s3cr3t-value");
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{8}$/);
		const c = await secretFingerprint("different-value");
		expect(c).not.toBe(a);
	});

	it("classifies failures as DecryptError or SecretKeyError", async () => {
		const env: SecretsEnv = { SECRETS_KEY: randomKeyB64() };
		const stored = await encryptSecret(env, "s3cr3t", "ctx");
		await expect(decryptSecret(env, stored, "other")).rejects.toBeInstanceOf(
			DecryptError,
		);
		await expect(decryptSecret(env, "garbage", "ctx")).rejects.toBeInstanceOf(
			DecryptError,
		);
		await expect(
			encryptSecret({ SECRETS_KEY: "short" }, "x", "ctx"),
		).rejects.toBeInstanceOf(SecretKeyError);
	});

	it("rejects truncated or corrupted ciphertext with DecryptError", async () => {
		const env: SecretsEnv = { SECRETS_KEY: randomKeyB64() };
		const stored = await encryptSecret(env, "s3cr3t", "ctx");
		const [v, kid, iv, ct] = stored.split(".") as [
			string,
			string,
			string,
			string,
		];
		for (const bad of [
			`${v}.${kid}.${iv}.${ct.slice(0, 4)}`,
			`${v}.${kid}.${iv.slice(0, 2)}.${ct}`,
			`${v}.${kid}.@@@@.${ct}`,
			`${v}.${kid}.${iv}.${ct}x`,
		]) {
			await expect(decryptSecret(env, bad, "ctx")).rejects.toBeInstanceOf(
				DecryptError,
			);
		}
	});

	it("accepts a key with surrounding whitespace (e.g. a trailing newline)", async () => {
		const key = randomKeyB64();
		const stored = await encryptSecret({ SECRETS_KEY: key }, "s3cr3t", "ctx");
		await expect(
			decryptSecret({ SECRETS_KEY: `  ${key}\n` }, stored, "ctx"),
		).resolves.toBe("s3cr3t");
	});

	it("never echoes a malformed key in the error message", async () => {
		const badKey = "my-very-private-but-broken-key!!";
		const err = await encryptSecret({ SECRETS_KEY: badKey }, "x", "ctx").catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(SecretKeyError);
		expect((err as Error).message).not.toContain(badKey);
	});
});
