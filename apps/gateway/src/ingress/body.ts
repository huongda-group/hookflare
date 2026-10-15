export const INLINE_BODY_LIMIT = 65_536;
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** M1 stores bodies inline only, so the effective cap is at most 64 KiB (§6 step 3). */
export function bodyCap(maxBodyBytes: number | null): number {
	return Math.min(maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, INLINE_BODY_LIMIT);
}
