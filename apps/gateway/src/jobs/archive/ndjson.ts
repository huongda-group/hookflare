export {
	base64,
	gunzipToLines,
	gzipLines,
	sha256Hex,
	toBytes,
} from "../../core/ndjson";

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
