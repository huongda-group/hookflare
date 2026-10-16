/**
 * Restore SQL generation for R2 backups: table ordering, INSERT/UPDATE
 * statements with chunked BLOB appends, orphan filtering, and numbered
 * SQL file writing. Portable (no node: imports): the gateway Miniflare
 * test imports `rowStatements` directly.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One backed-up table, mirroring the backup manifest shape.
 * @typedef {{ name: string, key: { column: string } | { rowid: true }, columns: { name: string, type: string, blob: boolean }[], foreign_keys: { column: string, table: string, to: string }[], rows: number, parts: { table: string, key: string, rows: number, bytes: number, sha256: string, blob_bytes: Record<string, number> }[] }} ManifestTable
 */

/**
 * Backup manifest: the tables plus their parts in R2.
 * @typedef {{ version: 1, backup_id: string, prefix: string, started_at: number, finished_at: number, d1_migrations: string[], tables: ManifestTable[] }} Manifest
 */

/**
 * Quote an identifier with `"` doubled.
 * @param {string} name
 * @returns {string}
 */
function ident(name) {
	return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote TEXT with `'` doubled.
 * @param {string} value
 * @returns {string}
 */
function textLiteral(value) {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Decode base64 with `atob` (node and workerd both provide it).
 * @param {string} b64
 * @returns {Uint8Array}
 */
function base64ToBytes(b64) {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}

/**
 * Lowercase hex of bytes.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToHex(bytes) {
	let out = "";
	for (const b of bytes) {
		out += b.toString(16).padStart(2, "0");
	}
	return out;
}

/**
 * True for a `{"$b64":"…"}` backup BLOB cell.
 * @param {unknown} value
 * @returns {value is { $b64: string }}
 */
function isB64(value) {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (/** @type {{ $b64?: unknown }} */ (value).$b64) === "string"
	);
}

/**
 * A value as SQL: TEXT quoted with `'` doubled, integers as they are
 * (booleans as 0/1), `null` as NULL, `{"$b64":…}` as `X'<hex>'`.
 * @param {unknown} value
 * @returns {string}
 */
export function valueLiteral(value) {
	if (value === null || value === undefined) {
		return "NULL";
	}
	if (typeof value === "number") {
		if (!Number.isInteger(value)) {
			throw new Error(`restore: non-integer number ${value}`);
		}
		return String(value);
	}
	if (typeof value === "bigint") {
		return String(value);
	}
	if (typeof value === "boolean") {
		return value ? "1" : "0";
	}
	if (typeof value === "string") {
		return textLiteral(value);
	}
	if (isB64(value)) {
		return `X'${bytesToHex(base64ToBytes(value.$b64))}'`;
	}
	throw new Error(
		`restore: unsupported value ${JSON.stringify(value)?.slice(0, 80)}`,
	);
}

/**
 * Tables in restore order: every parent before its children. Self
 * references are ignored for ordering; anything else that cycles throws
 * `restore: foreign key cycle: a -> b`.
 * @param {Manifest} manifest
 * @returns {string[]}
 */
export function tableOrder(manifest) {
	const names = manifest.tables.map((t) => t.name);
	const known = new Set(names);
	/** Child -> parents (within this manifest, minus self-refs). */
	const parents = new Map(names.map((n) => [n, new Set()]));
	for (const t of manifest.tables) {
		for (const fk of t.foreign_keys) {
			if (fk.table !== t.name && known.has(fk.table)) {
				parents.get(t.name).add(fk.table);
			}
		}
	}
	const order = [];
	const emitted = new Set();
	while (order.length < names.length) {
		let progress = false;
		for (const name of names) {
			if (emitted.has(name)) {
				continue;
			}
			const deps = parents.get(name);
			let ready = true;
			for (const p of deps) {
				if (!emitted.has(p)) {
					ready = false;
					break;
				}
			}
			if (ready) {
				emitted.add(name);
				order.push(name);
				progress = true;
			}
		}
		if (!progress) {
			throw new Error(
				`restore: foreign key cycle: ${findCycle(names, parents)}`,
			);
		}
	}
	return order;
}

/**
 * One cycle path (`a -> b`) for the error, via depth-first search.
 * @param {string[]} names
 * @param {Map<string, Set<string>>} parents
 * @returns {string}
 */
function findCycle(names, parents) {
	const state = new Map();
	const stack = [];
	const visit = (name) => {
		state.set(name, 1);
		stack.push(name);
		for (const p of parents.get(name) ?? []) {
			if (state.get(p) === 1) {
				return (
					[...stack.slice(stack.indexOf(p)), p].slice(0, -1).join(" -> ") || p
				);
			}
			if (!state.has(p)) {
				const found = visit(p);
				if (found) {
					return found;
				}
			}
		}
		stack.pop();
		state.set(name, 2);
		return null;
	};
	for (const name of names) {
		if (!state.has(name)) {
			const found = visit(name);
			if (found) {
				return found;
			}
		}
	}
	return names.join(" -> ");
}

/** Hex chars per BLOB append chunk: 32 KiB of bytes. */
const CHUNK_HEX = 65536;

/**
 * The `WHERE` locating a restored row: the primary key, or — for rowid
 * tables, whose rowid is not restored — every non-BLOB column. Only
 * `archive_parts` uses this, and it has no BLOBs.
 * @param {ManifestTable} table
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function rowWhere(table, row) {
	if ("column" in table.key) {
		return `${ident(table.key.column)} = ${valueLiteral(row[table.key.column])}`;
	}
	return table.columns
		.filter((c) => !c.blob)
		.map((c) => {
			const v = row[c.name] ?? null;
			return v === null || v === undefined
				? `${ident(c.name)} IS NULL`
				: `${ident(c.name)} = ${valueLiteral(v)}`;
		})
		.join(" AND ");
}

/**
 * INSERT for a row, plus one chunked `UPDATE … SET c = CAST(c || X'…'
 * AS BLOB)` per 32 KiB of BLOB bytes when the INSERT would exceed
 * `maxStmt`. Oversized BLOBs become `X''` in the INSERT.
 * @param {ManifestTable} table
 * @param {Record<string, unknown>} row
 * @param {number} [maxStmt]
 * @returns {string[]}
 */
export function rowStatements(table, row, maxStmt = 90000) {
	const literals = new Map();
	for (const c of table.columns) {
		literals.set(c.name, valueLiteral(row[c.name] ?? null));
	}
	const insert = () =>
		`INSERT INTO ${ident(table.name)} (${table.columns.map((c) => ident(c.name)).join(", ")}) VALUES (${table.columns.map((c) => literals.get(c.name)).join(", ")});`;
	const sql = insert();
	if (sql.length <= maxStmt) {
		return [sql];
	}
	const updates = [];
	for (const c of table.columns) {
		if (!c.blob) {
			continue;
		}
		const value = row[c.name] ?? null;
		if (!isB64(value)) {
			continue;
		}
		const hex = bytesToHex(base64ToBytes(value.$b64));
		if (hex.length === 0) {
			continue;
		}
		literals.set(c.name, `X''`);
		for (let i = 0; i < hex.length; i += CHUNK_HEX) {
			const chunk = hex.slice(i, i + CHUNK_HEX);
			updates.push(
				`UPDATE ${ident(table.name)} SET ${ident(c.name)} = CAST(${ident(c.name)} || X'${chunk}' AS BLOB) WHERE ${rowWhere(table, row)};`,
			);
		}
	}
	return [insert(), ...updates];
}

/**
 * Orphan report: dropped rows per table with a small sample.
 * @typedef {Record<string, { count: number, sample: unknown[] }>} OrphanReport
 */

/**
 * Admits rows whose non-null FK parents were already admitted, so a
 * missing parent drops its whole subtree (deliveries, then attempts).
 * Tables must be fed in `tableOrder`. A self-referencing FK is checked
 * against the keys seen so far in the same table (own key included),
 * since the full key set is only known once the table is streamed.
 * @param {Manifest} manifest
 * @returns {{ admit: (table: string | ManifestTable, row: Record<string, unknown>) => boolean, report: () => OrphanReport }}
 */
export function createOrphanFilter(manifest) {
	const byName = new Map(manifest.tables.map((t) => [t.name, t]));
	/** Table -> admitted parent key values. */
	const admitted = new Map();
	/** Table -> key values seen so far (for self-referencing FKs). */
	const seen = new Map();
	/** Table -> { count, sample }. */
	const orphans = new Map();
	for (const t of manifest.tables) {
		admitted.set(t.name, new Set());
		seen.set(t.name, new Set());
	}
	/**
	 * @param {string | ManifestTable} table
	 * @param {Record<string, unknown>} row
	 * @returns {boolean}
	 */
	function admit(table, row) {
		const info = typeof table === "string" ? byName.get(table) : table;
		if (!info) {
			throw new Error(
				`restore: unknown table ${typeof table === "string" ? table : "?"}`,
			);
		}
		const ownKey =
			"column" in info.key
				? (row[info.key.column] ?? null)
				: JSON.stringify(row);
		seen.get(info.name).add(ownKey);
		for (const fk of info.foreign_keys) {
			const value = row[fk.column] ?? null;
			if (value === null || value === undefined) {
				continue;
			}
			const keys =
				fk.table === info.name ? seen.get(info.name) : admitted.get(fk.table);
			// A self-reference to the row itself (or an earlier sibling) is
			// fine: the key was just added to `seen` above.
			if (fk.table === info.name && value === ownKey) {
				continue;
			}
			if (!keys?.has(value)) {
				let entry = orphans.get(info.name);
				if (!entry) {
					entry = { count: 0, sample: [] };
					orphans.set(info.name, entry);
				}
				entry.count += 1;
				if (entry.sample.length < 5) {
					entry.sample.push(row);
				}
				return false;
			}
		}
		admitted.get(info.name).add(ownKey);
		return true;
	}
	function report() {
		return Object.fromEntries(orphans);
	}
	return { admit, report };
}

/**
 * Numbered `NNNN.sql` files, each starting with
 * `PRAGMA defer_foreign_keys = true;`, rolling over at `maxBytes`.
 */
export class SqlFileWriter {
	/**
	 * @param {string} dir
	 * @param {number} [maxBytes]
	 */
	constructor(dir, maxBytes = 50000000) {
		this.dir = dir;
		this.maxBytes = maxBytes;
		this.files = [];
		this.index = 0;
		this.current = null;
		this.currentBytes = 0;
		mkdirSync(dir, { recursive: true });
	}

	/** @returns {void} */
	roll() {
		this.index += 1;
		const name = `${String(this.index).padStart(4, "0")}.sql`;
		this.current = join(this.dir, name);
		const header = "PRAGMA defer_foreign_keys = true;\n";
		writeFileSync(this.current, header);
		this.currentBytes = new TextEncoder().encode(header).length;
		this.files.push(this.current);
	}

	/**
	 * Append one statement (a trailing semicolon and newline are added).
	 * @param {string} sql
	 * @returns {void}
	 */
	writeStatement(sql) {
		const line = sql.endsWith("\n") ? sql : `${sql}\n`;
		const size = new TextEncoder().encode(line).length;
		if (this.current === null || this.currentBytes + size > this.maxBytes) {
			this.roll();
		}
		appendFileSync(this.current, line);
		this.currentBytes += size;
	}

	/**
	 * @returns {string[]} The SQL files written, in order.
	 */
	close() {
		return this.files;
	}
}
