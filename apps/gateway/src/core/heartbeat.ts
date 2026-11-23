import { sql } from "drizzle-orm";
import type { Db } from "../deps";

export const HEARTBEAT_KEY = "jobs.heartbeat";
export const HEARTBEAT_STALE_MS = 5 * 60_000;

export type JobName = "reconcile" | "alerts" | "rollup" | "backup";

const PATHS: Record<JobName, string> = {
	reconcile: "$.reconcile_at",
	alerts: "$.alerts_at",
	rollup: "$.rollup_at",
	backup: "$.backup_at",
};

export async function beat(db: Db, job: JobName, at: number): Promise<void> {
	const path = PATHS[job];
	await db.run(sql`
		INSERT INTO settings(key, value_json, updated_at)
		VALUES (${HEARTBEAT_KEY}, json_set('{}', '$.first_at', ${at}, ${path}, ${at}), ${at})
		ON CONFLICT(key) DO UPDATE SET
			value_json = json_set(settings.value_json, ${path}, ${at}),
			updated_at = ${at}`);
}

export function heartbeatStale(
	jobs: Record<string, number>,
	now: number,
): boolean {
	const at = jobs.reconcile_at;
	if (typeof at === "number") return now - at > HEARTBEAT_STALE_MS;
	const values = Object.values(jobs).filter(
		(v): v is number => typeof v === "number",
	);
	const since =
		typeof jobs.first_at === "number"
			? jobs.first_at
			: values.length > 0
				? Math.min(...values)
				: null;
	return since !== null && now - since > HEARTBEAT_STALE_MS;
}

export async function readHeartbeat(
	db: Db,
): Promise<Record<string, number> | null> {
	const [row] = await db.all<{ value_json: string }>(
		sql`SELECT value_json FROM settings WHERE key = ${HEARTBEAT_KEY}`,
	);
	if (!row) return null;
	try {
		const parsed: unknown = JSON.parse(row.value_json);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
			return null;
		return parsed as Record<string, number>;
	} catch {
		return null;
	}
}
