/**
 * `?next=` is attacker-controllable (Review Focus 1), so only a same-origin
 * absolute path is kept and everything else lands on the dashboard root.
 *
 * `new URL(next, "http://x")` rejects a scheme (`https://evil.example`) and, by
 * normalizing backslashes, a protocol-relative host (`//evil.example`,
 * `/\evil`). The original string is returned so a query string survives.
 */
export function safeNext(next: unknown): string {
	if (typeof next !== "string" || !next.startsWith("/")) return "/";
	if (next.startsWith("//") || next.startsWith("/\\")) return "/";
	try {
		if (new URL(next, "http://x").origin !== "http://x") return "/";
	} catch {
		return "/";
	}
	return next;
}
