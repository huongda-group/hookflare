import { describe, expect, it } from "vitest";
import { encryptSecret } from "../../src/core/crypto";
import {
	aad,
	activeSecrets,
	destinationSigningSecrets,
} from "../../src/core/secrets";
import { testDeps } from "../helpers/deps";
import { testEnv } from "../helpers/env";
import { seedPipeline } from "../helpers/seed";

describe("activeSecrets", () => {
	it("keeps the prev only before it expires", () => {
		const row = { enc: "c", prevEnc: "p", prevExpiresAt: 1000 };
		expect(activeSecrets(row, 999)).toEqual({ enc: "c", prevEnc: "p" });
		expect(activeSecrets(row, 1000)).toEqual({ enc: "c", prevEnc: null });
		expect(
			activeSecrets({ enc: "c", prevEnc: null, prevExpiresAt: null }, 0),
		).toEqual({ enc: "c", prevEnc: null });
	});
});

describe("destinationSigningSecrets", () => {
	it("returns current then prev while in grace", async () => {
		const deps = testDeps();
		const { destination } = await seedPipeline(deps);
		const env = testEnv();
		const prev = "whsec_cHJldmlvdXMtc2VjcmV0LWJ5dGVzLTMyLWxvbmchIQ==";
		const row = {
			...destination,
			signingSecretPrevEnc: await encryptSecret(
				env,
				prev,
				aad.destinationPrev(destination.id),
			),
			signingSecretPrevExpiresAt: 5000,
		};
		const secrets = await destinationSigningSecrets(env, row, 4000);
		expect(secrets).toHaveLength(2);
		expect(secrets[1]).toBe(prev);
		expect(await destinationSigningSecrets(env, row, 5000)).toHaveLength(1);
	});
});
