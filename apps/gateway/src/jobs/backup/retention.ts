import type { StorageSettings } from "@hookflare/shared";
import { desc, eq } from "drizzle-orm";
import { DAY_MS } from "../../core/db/archive";
import { backups } from "../../core/db/schema";
import type { Deps } from "../../deps";

/** R2 deletes land in chunks of 1,000 keys. */
export const RETENTION_DELETE_BATCH = 1000;

async function deletePrefix(
	deps: Pick<Deps, "backups">,
	prefix: string,
): Promise<void> {
	let cursor: string | undefined;
	do {
		const page = await deps.backups.list({ prefix, cursor });
		for (let i = 0; i < page.objects.length; i += RETENTION_DELETE_BATCH) {
			await deps.backups.delete(
				page.objects.slice(i, i + RETENTION_DELETE_BATCH).map((o) => o.key),
			);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

/**
 * Drops every backup older than `backup_retention_days` (by `started_at`),
 * except the newest `verified` one, which is always kept as the restore
 * fallback. A backup whose R2 delete fails keeps its row so the next run
 * retries it — the 7-day bucket lock makes recent deletes fail, which is
 * expected. Does nothing when `backup_enabled` is false.
 */
export async function expireBackups(
	deps: Pick<Deps, "db" | "backups">,
	settings: StorageSettings,
	now: number,
): Promise<{ deleted: string[] }> {
	if (!settings.backup_enabled) return { deleted: [] };
	const cutoff = now - settings.backup_retention_days * DAY_MS;
	const rows = await deps.db
		.select()
		.from(backups)
		.orderBy(desc(backups.startedAt));
	const newestVerified = rows.find((r) => r.status === "verified");
	const deleted: string[] = [];
	for (const row of rows) {
		if (row.startedAt >= cutoff) continue;
		if (newestVerified && row.id === newestVerified.id) continue;
		try {
			await deletePrefix(deps, row.prefix);
		} catch {
			continue;
		}
		await deps.db.delete(backups).where(eq(backups.id, row.id));
		deleted.push(row.id);
	}
	return { deleted };
}
