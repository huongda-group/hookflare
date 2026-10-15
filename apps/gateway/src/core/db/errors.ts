/** D1 wraps SQLite errors; walk the cause chain and match the SQLite message. */
function messages(err: unknown): string[] {
	const out: string[] = [];
	let cur: unknown = err;
	for (let i = 0; cur instanceof Error && i < 5; i++) {
		out.push(cur.message);
		cur = cur.cause;
	}
	return out;
}

export function isUniqueViolation(err: unknown): boolean {
	return messages(err).some((m) => m.includes("UNIQUE constraint failed"));
}
