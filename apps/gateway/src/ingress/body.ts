export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** Bodies above 64 KiB go to R2 (spec §6 step 3); max_body_bytes ≤ 10 MiB is enforced by the admin API. */
export function bodyCap(maxBodyBytes: number | null): number {
	return maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
}
