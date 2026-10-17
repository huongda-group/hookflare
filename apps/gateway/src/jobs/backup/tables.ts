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
 * Every user table in this D1, sorted by name: internal `sqlite_*` tables,
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
	return tables;
}

export { ident };
