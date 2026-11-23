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
