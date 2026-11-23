import { sql } from "drizzle-orm";
import type { Db } from "../../deps";

/** Rows per part for tables without BLOB columns. */
export const PAGE_SIZE = 5000;
/** Rows per part when any column is a BLOB: bodies can be 64 KiB each. */
export const BLOB_PAGE_SIZE = 250;

export type TableInfo = {
	name: string;
	key: { column: string } | { rowid: true };
	columns: { name: string; type: string; blob: boolean }[];
	foreignKeys: { column: string; table: string; to: string }[];
	pageSize: number;
};

type PragmaColumn = {
	name: string;
	type: string;
	pk: number;
};

type PragmaFk = {
	column: string;
	table: string;
	to: string;
};

/** Table names come from sqlite_schema, so quoting them back is safe. */
function ident(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** Pragma table functions take the table name as a string literal. */
function literal(name: string): string {
	return `'${name.replace(/'/g, "''")}'`;
}

/**
 * Parents before children (ties by name). The dump reads tables minutes
 * apart, so a row created between two reads is caught as an orphan child
 * (reported by the restore) instead of a parent silently missing its
 * children, e.g. an accepted event restored without its delivery.
 * Self references are ignored; a cycle keeps the remaining tables by name.
 */
export function parentsFirst(tables: TableInfo[]): TableInfo[] {
	const names = new Set(tables.map((t) => t.name));
	const pending = [...tables].sort((a, b) => a.name.localeCompare(b.name));
	const done = new Set<string>();
	const order: TableInfo[] = [];
	while (pending.length > 0) {
		const i = pending.findIndex((t) =>
			t.foreignKeys.every(
				(fk) =>
					fk.table === t.name || !names.has(fk.table) || done.has(fk.table),
			),
		);
		const [next] = pending.splice(i === -1 ? 0 : i, 1);
		done.add(next.name);
		order.push(next);
	}
	return order;
}

/**
 * Every user table in this D1, parents first (see `parentsFirst`): internal `sqlite_*` tables,
 * Cloudflare `_cf_*` bookkeeping, and the migration journal are skipped.
 * A table pages by its single-column primary key, or by rowid when it has
 * none (or a composite one, whose leading column alone is not unique).
 */
export async function listTables(db: Db): Promise<TableInfo[]> {
	const rows = await db.all<{ name: string }>(
		sql`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`,
	);
	const names = rows
		.map((r) => r.name)
		.filter(
			(n) =>
				!n.startsWith("sqlite_") &&
				!n.startsWith("_cf_") &&
				n !== "d1_migrations",
		);
	const tables: TableInfo[] = [];
	for (const name of names) {
		const lit = sql.raw(literal(name));
		const cols = await db.all<PragmaColumn>(
			sql`SELECT name, type, pk FROM pragma_table_info(${lit}) ORDER BY cid`,
		);
		const fks = await db.all<PragmaFk>(
			sql`SELECT "from" AS column, "table" AS "table", "to" AS "to" FROM pragma_foreign_key_list(${lit}) ORDER BY id, seq`,
		);
		const columns = cols.map((c) => ({
			name: c.name,
			type: c.type,
			blob: c.type.trim().toUpperCase() === "BLOB",
		}));
		const pk = cols.filter((c) => c.pk > 0);
		tables.push({
			name,
			key: pk.length === 1 ? { column: pk[0].name } : { rowid: true },
			columns,
			foreignKeys: fks.map((f) => ({
				column: f.column,
				table: f.table,
				to: f.to,
			})),
			pageSize: columns.some((c) => c.blob) ? BLOB_PAGE_SIZE : PAGE_SIZE,
		});
	}
	return parentsFirst(tables);
}

export { ident };
