export type PathSegment = { key: string } | { index: number };

const MAX_PATH_LENGTH = 256;
const SEGMENT = /\.([A-Za-z0-9_$-]+)|\[(\d{1,6})\]/y;

/**
 * Parses the provider-event-ID selector subset: `$` followed by one or more
 * `.key` / `[index]` segments (`$.id`, `$.data.object.id`, `$.items[0].id`).
 * Returns null for anything else, including a bare `$`.
 */
export function parseJsonPath(path: string): PathSegment[] | null {
	if (!path.startsWith("$") || path.length > MAX_PATH_LENGTH) {
		return null;
	}
	const segments: PathSegment[] = [];
	let pos = 1;
	while (pos < path.length) {
		SEGMENT.lastIndex = pos;
		const m = SEGMENT.exec(path);
		if (!m) {
			return null;
		}
		segments.push(m[1] !== undefined ? { key: m[1] } : { index: Number(m[2]) });
		pos = SEGMENT.lastIndex;
	}
	return segments.length > 0 ? segments : null;
}
