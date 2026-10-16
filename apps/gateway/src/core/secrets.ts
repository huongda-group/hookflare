import { type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { AppEnv } from "../env";
import type { SecretsEnv } from "./crypto";
import { decryptSecret, encryptSecret } from "./crypto";
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

const HOUR_MS = 3_600_000;

/**
 * Spec §11.3: the current secret moves to the prev column under the prev
 * AAD; any older prev is dropped. grace 0 keeps no prev at all.
 */
export async function rotationColumns(input: {
	env: AppEnv;
	currentEnc: string;
	currentAad: string;
	prevAad: string;
	newSecret: string;
	newAad: string;
	graceHours: number;
	now: number;
}): Promise<{
	enc: string;
	prevEnc: string | null;
	prevExpiresAt: number | null;
}> {
	const enc = await encryptSecret(input.env, input.newSecret, input.newAad);
	if (input.graceHours === 0)
		return { enc, prevEnc: null, prevExpiresAt: null };
	const current = await decryptSecret(
		input.env,
		input.currentEnc,
		input.currentAad,
	);
	return {
		enc,
		prevEnc: await encryptSecret(input.env, current, input.prevAad),
		prevExpiresAt: input.now + input.graceHours * HOUR_MS,
	};
}

/**
 * SET values that clear an expired prev. Decided inside the UPDATE, not from
 * an earlier read, so a rotation that lands in between keeps its fresh prev.
 */
export function clearExpiredPrev(
	prevEnc: SQLiteColumn,
	prevExpiresAt: SQLiteColumn,
	now: number,
): { enc: SQL; expiresAt: SQL } {
	const expired = sql`${prevExpiresAt} IS NOT NULL AND ${prevExpiresAt} <= ${now}`;
	return {
		enc: sql`CASE WHEN ${expired} THEN NULL ELSE ${prevEnc} END`,
		expiresAt: sql`CASE WHEN ${expired} THEN NULL ELSE ${prevExpiresAt} END`,
	};
}
