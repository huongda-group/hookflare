import { eq } from "drizzle-orm";
import { settings } from "../core/db/schema";
import {
	floorHour,
	HOUR_MS,
	oldestEventAt,
	rollupHourStatements,
} from "../core/db/stats";
import type { Logger } from "../core/log";
import type { Deps } from "../deps";

export const ROLLUP_RECENT_HOURS = 3;
export const BACKFILL_HOURS_PER_RUN = 6;
/** settings value: the start of the oldest hour already recomputed, or "done". */
export const BACKFILL_KEY = "rollup.backfill_before";

export type RollupReport = {
	hours: number[];
	failed_hours: number[];
	backfill_before: number | "done";
};

async function readCursor(deps: Deps): Promise<number | "done" | null> {
	const row = await deps.db
		.select()
		.from(settings)
		.where(eq(settings.key, BACKFILL_KEY))
		.get();
	if (!row) return null;
	const value: unknown = JSON.parse(row.valueJson);
	return value === "done" || typeof value === "number" ? value : null;
}

async function writeCursor(deps: Deps, value: number | "done") {
	const valueJson = JSON.stringify(value);
	const updatedAt = deps.now();
	await deps.db
		.insert(settings)
		.values({ key: BACKFILL_KEY, valueJson, updatedAt })
		.onConflictDoUpdate({
			target: settings.key,
			set: { valueJson, updatedAt },
		});
}

/** Spec §6.2. Never increments: every hour it touches is rebuilt from source rows. */
export async function rollup(
	deps: Deps,
	logger: Logger,
): Promise<RollupReport> {
	const current = floorHour(deps.now());
	const hours: number[] = [];
	const failed: number[] = [];

	const recompute = async (hour: number): Promise<boolean> => {
		hours.push(hour);
		try {
			await deps.db.batch(rollupHourStatements(deps.db, hour));
			return true;
		} catch (err) {
			failed.push(hour);
			logger.error("rollup.hour_failed", { hour, error: String(err) });
			return false;
		}
	};

	for (let i = 0; i < ROLLUP_RECENT_HOURS; i++) {
		await recompute(current - i * HOUR_MS);
	}

	const oldestRecent = current - (ROLLUP_RECENT_HOURS - 1) * HOUR_MS;
	let cursor = (await readCursor(deps)) ?? oldestRecent;
	if (cursor !== "done") {
		const oldest = await oldestEventAt(deps.db);
		const floor = oldest === null ? null : floorHour(oldest);
		if (floor === null || floor >= cursor) {
			cursor = "done";
		} else {
			// Stop at the first failure so the cursor never skips an hour.
			for (let i = 0; i < BACKFILL_HOURS_PER_RUN; i++) {
				const hour: number = cursor - HOUR_MS;
				if (hour < floor || !(await recompute(hour))) break;
				cursor = hour;
			}
			if (cursor <= floor) cursor = "done";
		}
		await writeCursor(deps, cursor);
	}

	return { hours, failed_hours: failed, backfill_before: cursor };
}
