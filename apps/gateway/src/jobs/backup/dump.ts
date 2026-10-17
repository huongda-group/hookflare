import { sql } from "drizzle-orm";
import { base64, gzipLines, sha256Hex, toBytes } from "../../core/ndjson";
import type { Deps } from "../../deps";
import { ident, type TableInfo } from "./tables";

export type PartMeta = {
	table: string;
	key: string;
	rows: number;
	bytes: number;
	sha256: string;
	blob_bytes: Record<string, number>;
};

/** R2 key of one gzip NDJSON part. */
export function partKey(prefix: string, table: string, partNo: number): string {
	return `${prefix}${table}/part-${String(partNo).padStart(4, "0")}.ndjson.gz`;
}

/**
 * One backup part: `pageSize` rows after `cursor`, gzipped NDJSON in R2.
 * BLOB cells become `{"$b64":"…"}`, so the file is plain JSON text and the
 * bytes survive a gunzip-plus-base64 round trip. A full page returns its
 * last key as the next cursor; anything shorter ends the table.
 */
export async function dumpPage(
	deps: Pick<Deps, "db" | "backups">,
	table: TableInfo,
	prefix: string,
	partNo: number,
	cursor: string | number | null,
): Promise<{ part: PartMeta | null; next: string | number | null }> {
	const keySql =
		"column" in table.key ? sql.raw(ident(table.key.column)) : sql.raw("rowid");
	const byRowid = !("column" in table.key);
	const rows = await deps.db.all<Record<string, unknown>>(sql`
		SELECT ${byRowid ? sql.raw("rowid AS __cursor, *") : sql.raw("*")}
		FROM ${sql.raw(ident(table.name))}
		${cursor === null ? sql.raw("") : sql`WHERE ${keySql} > ${cursor}`}
		ORDER BY ${keySql} LIMIT ${sql.raw(String(table.pageSize))}`);
	if (rows.length === 0) return { part: null, next: null };

	const blobCols = table.columns.filter((c) => c.blob).map((c) => c.name);
	const blobSet = new Set(blobCols);
	const blob_bytes: Record<string, number> = Object.fromEntries(
		blobCols.map((c) => [c, 0]),
	);
	async function* lines(): AsyncGenerator<string> {
		for (const row of rows) {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(row)) {
				if (k === "__cursor") continue;
				if (blobSet.has(k)) {
					if (v == null) {
						out[k] = null;
					} else {
						const bytes = toBytes(v);
						blob_bytes[k] += bytes.byteLength;
						out[k] = { $b64: base64(bytes) };
					}
				} else {
					out[k] = v;
				}
			}
			yield JSON.stringify(out);
		}
	}
	const gz = await gzipLines(lines());
	const sha256 = await sha256Hex(gz);
	const key = partKey(prefix, table.name, partNo);
	await deps.backups.put(key, gz, { sha256 });

	const last = rows[rows.length - 1];
	const lastKey = (
		"column" in table.key ? last[table.key.column] : last.__cursor
	) as string | number;
	return {
		part: {
			table: table.name,
			key,
			rows: rows.length,
			bytes: gz.byteLength,
			sha256,
			blob_bytes,
		},
		next: rows.length < table.pageSize ? null : lastKey,
	};
}
