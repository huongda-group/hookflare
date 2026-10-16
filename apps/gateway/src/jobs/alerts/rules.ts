import type { AlertRules } from "@hookflare/shared";
import { eq, sql } from "drizzle-orm";
import type { ActiveAlert, OpenAlertRow } from "../../core/db/alerts";
import { settings } from "../../core/db/schema";
import type { Db, Deps } from "../../deps";

export const D1_LIMIT_BYTES = 10 * 1024 ** 3;
export const DEAD_CURSOR_KEY = "alerts.dead_cursor";
/** Room for clock skew between isolates stamping completed_at (plan deviation). */
export const DEAD_CURSOR_LAG_MS = 10_000;
const NEWEST_IDS = 5;
/** Per-run bounds of the new_dead scan (Minor 6); the rest is read next run. */
export const DEAD_SCAN_LIMIT = 1_000;
export const DEAD_MAX_DESTINATIONS = 100;

export async function consecutiveFailures(
	db: Db,
	rules: AlertRules,
): Promise<ActiveAlert[]> {
	const rows = await db.all<{ id: string; project_id: string; n: number }>(sql`
		SELECT id, project_id, consecutive_failures AS n FROM destinations
		WHERE consecutive_failures >= ${rules.failure_threshold} AND status = 'active'`);
	return rows.map((r) => ({
		rule: "consecutive_failures",
		resourceType: "destination",
		resourceId: r.id,
		projectId: r.project_id,
		details: { consecutive_failures: r.n },
	}));
}

/** Paused destinations hold `paused` deliveries, so they never match (spec §6.2). */
export async function stuckPending(
	db: Db,
	rules: AlertRules,
	now: number,
): Promise<ActiveAlert[]> {
	const rows = await db.all<{
		destination_id: string;
		project_id: string;
		n: number;
		oldest: number;
	}>(sql`
		SELECT d.destination_id, dst.project_id, COUNT(*) AS n, MIN(d.created_at) AS oldest
		FROM deliveries d JOIN destinations dst ON dst.id = d.destination_id
		WHERE d.status IN ('pending', 'queued') AND d.created_at < ${now - rules.stuck_after_s * 1000}
			AND dst.status = 'active'
		GROUP BY d.destination_id`);
	return rows.map((r) => ({
		rule: "stuck_pending",
		resourceType: "destination",
		resourceId: r.destination_id,
		projectId: r.project_id,
		details: { stuck: r.n, oldest_created_at: r.oldest },
	}));
}

async function readDeadCursor(db: Db): Promise<number | null> {
	const row = await db
		.select()
		.from(settings)
		.where(eq(settings.key, DEAD_CURSOR_KEY))
		.get();
	if (!row) return null;
	const at = (JSON.parse(row.valueJson) as { at?: unknown }).at;
	return typeof at === "number" ? at : null;
}

/**
 * M5-13. New dead deliveries in (cursor, now − lag] open or refresh an incident;
 * an open incident stays active until dead_quiet_s passes with nothing new.
 * A missing cursor starts at now − lag without alerting on history.
 */
export async function newDead(
	db: Db,
	rules: AlertRules,
	open: OpenAlertRow[],
	now: number,
) {
	const from = await readDeadCursor(db);
	let to = now - DEAD_CURSOR_LAG_MS;
	const active = new Map<string, ActiveAlert>();
	if (from !== null && to > from) {
		const scanned = await scanDead(db, from, to);
		to = scanned.to;
		for (const r of scanned.rows) {
			const a = active.get(r.destination_id) ?? {
				rule: "new_dead" as const,
				resourceType: "destination" as const,
				resourceId: r.destination_id,
				projectId: r.project_id,
				details: {
					new_dead: 0,
					delivery_ids: [] as string[],
					last_dead_at: r.completed_at,
				},
			};
			const d = a.details as { new_dead: number; delivery_ids: string[] };
			d.new_dead++;
			if (d.delivery_ids.length < NEWEST_IDS) d.delivery_ids.push(r.id);
			active.set(r.destination_id, a);
		}
	}
	for (const o of open) {
		if (o.rule !== "new_dead" || active.has(o.resourceId)) continue;
		const details = JSON.parse(o.detailsJson) as { last_dead_at?: number };
		if (
			(details.last_dead_at ?? o.openedAt) >
			now - rules.dead_quiet_s * 1000
		) {
			active.set(o.resourceId, {
				rule: "new_dead",
				resourceType: "destination",
				resourceId: o.resourceId,
				projectId: o.projectId,
				details,
				carryOver: true,
			});
		}
	}
	return { active: [...active.values()], cursor: { from, to } };
}

type DeadRow = {
	id: string;
	destination_id: string;
	project_id: string;
	completed_at: number;
};

const deadRows = (db: Db, where: ReturnType<typeof sql>, limit?: number) =>
	db.all<DeadRow>(sql`
		SELECT d.id, d.destination_id, dst.project_id, d.completed_at
		FROM deliveries d JOIN destinations dst ON dst.id = d.destination_id
		WHERE d.status = 'dead' AND ${where}
		ORDER BY d.completed_at ASC, d.id ASC
		${limit === undefined ? sql`` : sql`LIMIT ${limit}`}`);

/**
 * Oldest first, at most DEAD_SCAN_LIMIT rows and DEAD_MAX_DESTINATIONS
 * destinations per run. When the window is cut short, `to` stops just before
 * the first unprocessed millisecond, so the cursor only passes rows this run
 * counted and the rest are read next minute. Returns newest first.
 */
export async function scanDead(
	db: Db,
	from: number,
	to: number,
): Promise<{ rows: DeadRow[]; to: number }> {
	const rows = await deadRows(
		db,
		sql`d.completed_at > ${from} AND d.completed_at <= ${to}`,
		DEAD_SCAN_LIMIT + 1,
	);
	let cut = Math.min(rows.length, DEAD_SCAN_LIMIT);
	const seen = new Set<string>();
	for (let i = 0; i < cut; i++) {
		if (seen.has(rows[i].destination_id)) continue;
		if (seen.size === DEAD_MAX_DESTINATIONS) {
			cut = i;
			break;
		}
		seen.add(rows[i].destination_id);
	}
	if (cut === rows.length) return { rows: rows.reverse(), to };
	const boundary = rows[cut].completed_at;
	const kept = rows.slice(0, cut).filter((r) => r.completed_at < boundary);
	if (kept.length > 0) return { rows: kept.reverse(), to: boundary - 1 };
	// Every scanned row shares one millisecond: take it whole so the cursor still moves.
	const tied = await deadRows(db, sql`d.completed_at = ${boundary}`);
	return { rows: tied.reverse(), to: boundary };
}

/** Never moves the cursor backwards, even when an older run writes last. */
export function deadCursorStatement(db: Db, at: number, now: number) {
	return db
		.insert(settings)
		.values({
			key: DEAD_CURSOR_KEY,
			valueJson: JSON.stringify({ at }),
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: settings.key,
			set: {
				valueJson: sql`excluded.value_json`,
				updatedAt: sql`excluded.updated_at`,
			},
			setWhere: sql`coalesce(json_extract(${settings.valueJson}, '$.at'), -1) < ${at}`,
		});
}

/** `meta.size_after` of any query is the database size in bytes. */
export async function readD1SizeBytes(db: Db): Promise<number> {
	const r = (await db.run(sql`SELECT 1`)) as unknown as {
		meta: { size_after?: number };
	};
	return r.meta.size_after ?? 0;
}

/** Hysteresis: opens at d1_warn_pct, stays open down to d1_warn_pct − 5. */
export async function d1Storage(
	db: Db,
	rules: AlertRules,
	open: Pick<OpenAlertRow, "rule">[],
	sizeBytes?: number,
): Promise<ActiveAlert[]> {
	const size = sizeBytes ?? (await readD1SizeBytes(db));
	const pct = (size / D1_LIMIT_BYTES) * 100;
	const isOpen = open.some((o) => o.rule === "d1_storage");
	const threshold = isOpen ? rules.d1_warn_pct - 5 : rules.d1_warn_pct;
	if (pct < threshold) return [];
	return [
		{
			rule: "d1_storage",
			resourceType: "system",
			resourceId: "d1",
			projectId: null,
			details: { size_bytes: size, percent: Math.round(pct * 10) / 10 },
		},
	];
}

export type Evaluation = {
	active: ActiveAlert[];
	deadCursor: { from: number | null; to: number };
};

export const ARCHIVE_STUCK_AFTER_MS = 48 * 3_600_000;

/**
 * Spec §7.4 monitoring: a failed batch needs an operator until a later batch of
 * the same kind and day succeeds (failed days are retried); one stuck in
 * building is a dead run.
 */
export async function archiveStuck(
	db: Db,
	now: number,
): Promise<ActiveAlert[]> {
	const rows = await db.all<{ id: string }>(sql`
		SELECT b.id FROM archive_batches b
		WHERE (b.status = 'failed' AND NOT EXISTS (
				SELECT 1 FROM archive_batches r
				WHERE r.kind = b.kind AND r.day = b.day AND r.created_at > b.created_at
					AND r.status IN ('verified', 'purged', 'expired')))
			OR (b.status = 'building' AND b.created_at < ${now - ARCHIVE_STUCK_AFTER_MS})
		ORDER BY b.created_at DESC LIMIT 20`);
	if (rows.length === 0) return [];
	return [
		{
			rule: "archive_stuck",
			resourceType: "system",
			resourceId: "archive",
			projectId: null,
			details: { batch_ids: rows.map((r) => r.id) },
		},
	];
}

export async function evaluateRules(
	deps: Pick<Deps, "db" | "now">,
	rules: AlertRules,
	open: OpenAlertRow[],
): Promise<Evaluation> {
	const now = deps.now();
	const [cf, stuck, dead, d1, stuckArchive] = await Promise.all([
		consecutiveFailures(deps.db, rules),
		stuckPending(deps.db, rules, now),
		newDead(deps.db, rules, open, now),
		d1Storage(deps.db, rules, open),
		archiveStuck(deps.db, now),
	]);
	return {
		active: [...cf, ...stuck, ...dead.active, ...d1, ...stuckArchive],
		deadCursor: dead.cursor,
	};
}
