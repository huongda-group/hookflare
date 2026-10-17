import { eq, sql } from "drizzle-orm";
import { backups } from "../../core/db/schema";
import { sha256Hex } from "../../core/ndjson";
import type { Deps } from "../../deps";
import type { PartMeta } from "./dump";
import type { TableInfo } from "./tables";

export type ManifestTable = {
	name: string;
	key: { column: string } | { rowid: true };
	columns: { name: string; type: string; blob: boolean }[];
	foreign_keys: { column: string; table: string; to: string }[];
	rows: number;
	parts: PartMeta[];
};

export type Manifest = {
	version: 1;
	backup_id: string;
	prefix: string;
	started_at: number;
	finished_at: number;
	d1_migrations: string[];
	tables: ManifestTable[];
};

/**
 * The backup's table of contents: which migrations were applied, and the
 * parts (with their checksums) holding every table. The row keeps the
 * roll-up counts so the admin UI never reads R2.
 */
export async function writeManifest(
	deps: Pick<Deps, "db" | "backups" | "now">,
	backupId: string,
	tables: TableInfo[],
	parts: PartMeta[],
	startedAt: number,
): Promise<Manifest> {
	const row = await deps.db
		.select()
		.from(backups)
		.where(eq(backups.id, backupId))
		.get();
	if (!row) throw new Error(`backup ${backupId} not found`);
	const applied = await deps.db.all<{ name: string }>(
		sql`SELECT name FROM d1_migrations ORDER BY id`,
	);
	const manifest: Manifest = {
		version: 1,
		backup_id: backupId,
		prefix: row.prefix,
		started_at: startedAt,
		finished_at: deps.now(),
		d1_migrations: applied.map((m) => m.name),
		tables: tables.map((t) => {
			const own = parts.filter((p) => p.table === t.name);
			return {
				name: t.name,
				key: t.key,
				columns: t.columns,
				foreign_keys: t.foreignKeys,
				rows: own.reduce((s, p) => s + p.rows, 0),
				parts: own,
			};
		}),
	};
	const bytes = new TextEncoder().encode(JSON.stringify(manifest));
	const sha256 = await sha256Hex(bytes);
	await deps.backups.put(`${row.prefix}manifest.json`, bytes, { sha256 });
	await deps.db
		.update(backups)
		.set({
			partCount: parts.length,
			bytes: parts.reduce((s, p) => s + p.bytes, 0) + bytes.byteLength,
			rowCountsJson: JSON.stringify(
				Object.fromEntries(manifest.tables.map((t) => [t.name, t.rows])),
			),
		})
		.where(eq(backups.id, backupId));
	return manifest;
}
