import { b64urlToBytes, bytesToB64url } from "../core/crypto";

/** Opaque keyset cursor over (time, id), newest first (spec §8.1). */
export function encodeCursor(at: number, id: string): string {
	return bytesToB64url(new TextEncoder().encode(JSON.stringify({ at, id })));
}

export function decodeCursor(
	raw: string | undefined,
): { at: number; id: string } | null | "invalid" {
	if (raw === undefined) return null;
	try {
		const v = JSON.parse(new TextDecoder().decode(b64urlToBytes(raw)));
		if (Number.isSafeInteger(v?.at) && typeof v?.id === "string") {
			return { at: v.at, id: v.id };
		}
	} catch {
		// fall through
	}
	return "invalid";
}
