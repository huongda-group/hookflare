/**
 * `?next=` is attacker-controllable (Review Focus 1), so only a same-origin
 * absolute dashboard path is kept and everything else lands on the dashboard
 * root. Authentication pages are not post-login destinations.
 *
 * `new URL(next, "http://x")` rejects a scheme (`https://evil.example`) and, by
 * normalizing backslashes, a protocol-relative host (`//evil.example`,
 * `/\evil`). The original string is returned so a query string survives.
 */
export function safeNext(next: unknown): string {
	if (typeof next !== "string" || !next.startsWith("/")) return "/";
	if (next.startsWith("//") || next.startsWith("/\\")) return "/";
	try {
		const { origin, pathname } = new URL(next, "http://x");
		if (origin !== "http://x" || /^\/(?:login|setup)\/?$/.test(pathname))
			return "/";
	} catch {
		return "/";
	}
	return next;
}
