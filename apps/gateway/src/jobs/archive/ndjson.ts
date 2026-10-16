// Byte helpers live in core so every job module can use them without
// importing across job modules (jobs/** may only import core/**, deps, own).
export {
	base64,
	gunzipToLines,
	gzipLines,
	sha256Hex,
	toBytes,
} from "../../core/ndjson";

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
