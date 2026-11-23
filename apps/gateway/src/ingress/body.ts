export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export function bodyCap(maxBodyBytes: number | null): number {
	return maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
}
