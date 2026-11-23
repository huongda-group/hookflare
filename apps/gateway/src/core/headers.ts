import { redactHeaders } from "./log";

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"content-length",
]);

export const CREDENTIAL_HEADERS = ["authorization", "cookie", "x-api-key"];

const DROPPED_PREFIXES = ["proxy-", "cf-"];

export function isDroppedHeader(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		HOP_BY_HOP.has(lower) || DROPPED_PREFIXES.some((p) => lower.startsWith(p))
	);
}

export function storableHeaders(
	headers: Headers,
	authHeader: string | null,
): Record<string, string> {
	const redacted = redactHeaders(
		headers,
		authHeader ? [...CREDENTIAL_HEADERS, authHeader] : CREDENTIAL_HEADERS,
	);
	return Object.fromEntries(
		Object.entries(redacted).filter(([name]) => !isDroppedHeader(name)),
	);
}
