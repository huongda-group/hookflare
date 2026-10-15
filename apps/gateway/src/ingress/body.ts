export const INLINE_BODY_LIMIT = 65_536;
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** M1 stores bodies inline only, so the effective cap is at most 64 KiB (§6 step 3). */
export function bodyCap(maxBodyBytes: number | null): number {
	return Math.min(maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, INLINE_BODY_LIMIT);
}

/** Reads at most `cap` bytes; null means the body is larger than `cap`. */
export async function readCappedBody(
	request: Request,
	cap: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > cap) {
		return null;
	}
	if (!request.body) {
		return new Uint8Array(new ArrayBuffer(0));
	}
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > cap) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(new ArrayBuffer(total));
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}
