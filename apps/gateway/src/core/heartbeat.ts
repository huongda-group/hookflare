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

/**
 * Records a successful job run. One statement: the settings row is created
 * from `{first_at}` when missing, otherwise the job's key is merged in.
 * `first_at` dates the row, so `/healthz` can tell a new deployment from a
 * reconciler that never beat. Throws on failure: the caller logs
 * `heartbeat.failed` and must not let it fail the job.
 */
export async function beat(db: Db, job: JobName, at: number): Promise<void> {
	const path = PATHS[job];
	await db.run(sql`
		INSERT INTO settings(key, value_json, updated_at)
		VALUES (${HEARTBEAT_KEY}, json_set('{}', '$.first_at', ${at}, ${path}, ${at}), ${at})
		ON CONFLICT(key) DO UPDATE SET
			value_json = json_set(settings.value_json, ${path}, ${at}),
			updated_at = ${at}`);
}

/**
 * True when the reconciler's heartbeat is older than `HEARTBEAT_STALE_MS`,
 * or when it never beat although the row (`first_at`, else its oldest key)
 * is older than that.
 */
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

/** The merged heartbeat map, or null when no job has beaten yet. */
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
