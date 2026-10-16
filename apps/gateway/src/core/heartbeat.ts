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
 * from `{}` when missing, otherwise the job's key is merged in. Never
 * throws: a heartbeat must not fail the job, so failures are swallowed for
 * the caller to log.
 */
export async function beat(db: Db, job: JobName, at: number): Promise<void> {
	try {
		const path = PATHS[job];
		await db.run(sql`
			INSERT INTO settings(key, value_json, updated_at)
			VALUES (${HEARTBEAT_KEY}, json_set('{}', ${path}, ${at}), ${at})
			ON CONFLICT(key) DO UPDATE SET
				value_json = json_set(settings.value_json, ${path}, ${at}),
				updated_at = ${at}`);
	} catch {
		// Swallowed by contract.
	}
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
