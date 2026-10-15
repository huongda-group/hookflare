import type { SecretsEnv } from "./crypto";
import { decryptSecret } from "./crypto";
import type { DestinationRow } from "./db/schema";

/** AAD binds each ciphertext to its column (spec §11.3). */
export const aad = {
	source: (id: string) => `sources.secret_enc:${id}`,
	sourcePrev: (id: string) => `sources.secret_prev_enc:${id}`,
	destination: (id: string) => `destinations.signing_secret_enc:${id}`,
	destinationPrev: (id: string) => `destinations.signing_secret_prev_enc:${id}`,
};

/** An expired prev is ignored; its columns are cleared on the next write. */
export function activeSecrets(
	row: { enc: string; prevEnc: string | null; prevExpiresAt: number | null },
	now: number,
): { enc: string; prevEnc: string | null } {
	const live =
		row.prevEnc !== null &&
		row.prevExpiresAt !== null &&
		row.prevExpiresAt > now;
	return { enc: row.enc, prevEnc: live ? row.prevEnc : null };
}

/** Decrypted signing secrets, current first (spec M3-3). */
export async function destinationSigningSecrets(
	env: SecretsEnv,
	d: DestinationRow,
	now: number,
): Promise<string[]> {
	const { enc, prevEnc } = activeSecrets(
		{
			enc: d.signingSecretEnc,
			prevEnc: d.signingSecretPrevEnc,
			prevExpiresAt: d.signingSecretPrevExpiresAt,
		},
		now,
	);
	const out = [await decryptSecret(env, enc, aad.destination(d.id))];
	if (prevEnc)
		out.push(await decryptSecret(env, prevEnc, aad.destinationPrev(d.id)));
	return out;
}
