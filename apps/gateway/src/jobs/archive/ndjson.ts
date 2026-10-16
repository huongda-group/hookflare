export async function gzipLines(
	lines: AsyncIterable<string>,
): Promise<Uint8Array> {
	const cs = new CompressionStream("gzip");
	// Start draining before writing, or backpressure stalls the writer.
	const out = new Response(cs.readable).arrayBuffer();
	const writer = cs.writable.getWriter();
	const enc = new TextEncoder();
	for await (const line of lines) await writer.write(enc.encode(`${line}\n`));
	await writer.close();
	return new Uint8Array(await out);
}

export async function gunzipToLines(bytes: Uint8Array): Promise<string[]> {
	const buf = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buf).set(bytes);
	const text = await new Response(
		new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip")),
	).text();
	return text.split("\n").filter((l) => l.length > 0);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(d)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** D1 returns blobs as ArrayBuffer, Uint8Array, or number[] depending on the path. */
export function toBytes(v: unknown): Uint8Array {
	if (v instanceof Uint8Array) return v;
	if (v instanceof ArrayBuffer) return new Uint8Array(v);
	if (Array.isArray(v)) return Uint8Array.from(v as number[]);
	return new Uint8Array();
}

export function base64(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

/** Map.groupBy needs ES2024 lib; tsconfig targets ES2022. */
export function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
	const out = new Map<K, T[]>();
	for (const item of items) {
		const k = key(item);
		const list = out.get(k);
		if (list) list.push(item);
		else out.set(k, [item]);
	}
	return out;
}
