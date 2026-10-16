export function dayOf(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export function dayStartOf(day: string): number {
	return Date.parse(`${day}T00:00:00.000Z`);
}

/** archive/YYYY/MM/DD/<batch>/ — batch-scoped because one day is archived more than once (M5-18). */
export function batchPrefix(
	kind: "events" | "audit",
	day: string,
	batchId: string,
): string {
	const path = day.replaceAll("-", "/");
	return kind === "audit"
		? `archive/audit/${path}/${batchId}/`
		: `archive/${path}/${batchId}/`;
}

export function partKey(prefix: string, partNo: number): string {
	return `${prefix}part-${String(partNo).padStart(4, "0")}.ndjson.gz`;
}

export function manifestKey(prefix: string): string {
	return `${prefix}manifest.json`;
}
