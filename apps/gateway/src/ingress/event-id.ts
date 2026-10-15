import { parseJsonPath } from "@hookflare/shared";
import type { EventIdFrom } from "../core/db/schema";

export const MAX_EVENT_ID_LENGTH = 256;

function normalize(value: unknown): string | null {
	const s =
		typeof value === "string"
			? value.trim()
			: typeof value === "number" && Number.isFinite(value)
				? String(value)
				: null;
	return s && s.length <= MAX_EVENT_ID_LENGTH ? s : null;
}

/** Best effort: any failure yields null and never rejects the request (§6.2). Runs after verification. */
export function extractEventId(
	from: EventIdFrom,
	selector: string | null,
	headers: Headers,
	body: Uint8Array,
): string | null {
	if (from === "none" || !selector) {
		return null;
	}
	if (from === "header") {
		return normalize(headers.get(selector));
	}
	const path = parseJsonPath(selector);
	if (!path) {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
		);
	} catch {
		return null;
	}
	for (const seg of path) {
		if ("index" in seg) {
			value = Array.isArray(value) ? value[seg.index] : undefined;
		} else {
			value =
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				Object.hasOwn(value, seg.key)
					? (value as Record<string, unknown>)[seg.key]
					: undefined;
		}
	}
	return normalize(value);
}
