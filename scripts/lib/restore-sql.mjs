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

/** UTF-8 bytes per TEXT append chunk, after `'` doubling. */
const CHUNK_TEXT_BYTES = 65536;

const utf8 = new TextEncoder();

/**
 * UTF-8 byte length of a string (what D1 limits), not UTF-16 units.
 * @param {string} s
 * @returns {number}
 */
export function utf8Length(s) {
	return utf8.encode(s).length;
}

/**
 * UTF-8 bytes of one code point (a lone surrogate encodes as U+FFFD).
 * @param {number} cp
 * @returns {number}
 */
function codePointBytes(cp) {
	if (cp < 0x80) {
		return 1;
	}
	if (cp < 0x800) {
		return 2;
	}
	if (cp < 0x10000) {
		return 3;
	}
	return 4;
}

/**
 * Split TEXT into `'`-doubled chunks on whole code points, each at most
 * `budget` UTF-8 bytes after doubling.
 * @param {string} value
 * @param {number} budget
 * @returns {string[]}
 */
function textChunks(value, budget) {
	const chunks = [];
	let chunk = "";
	let bytes = 0;
	for (const ch of value) {
		const quote = ch === "'";
		const n = quote ? 2 : codePointBytes(ch.codePointAt(0) ?? 0);
		if (bytes + n > budget && chunk.length > 0) {
			chunks.push(chunk);
			chunk = "";
			bytes = 0;
		}
		chunk += quote ? "''" : ch;
		bytes += n;
	}
	if (chunk.length > 0) {
		chunks.push(chunk);
	}
	return chunks;
}

/**
 * INSERT for a row. When the INSERT is not under `maxStmt` UTF-8 bytes,
 * the largest TEXT and BLOB values become `''` / `X''` (largest first,
 * until the INSERT fits) and are appended back with chunked
 * `UPDATE … SET c = c || '…'` (TEXT, split on whole code points) or
 * `UPDATE … SET c = CAST(c || X'…' AS BLOB)` (at most 32 KiB of bytes
 * per chunk). Every statement is under `maxStmt` UTF-8 bytes; NULL, `''`
 * and `X''` are never split. Splitting needs a key column, so an
 * oversized row in a rowid table throws.
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
	let sql = insert();
	if (utf8Length(sql) < maxStmt) {
		return [sql];
	}
	if (!("column" in table.key)) {
		throw new Error(
			`restore: a row in ${table.name} is ${utf8Length(sql)} bytes and the table has no key column to split on`,
		);
	}
	const keyColumn = table.key.column;
	const candidates = table.columns
		.filter((c) => {
			const v = row[c.name] ?? null;
			return (
				c.name !== keyColumn &&
				((typeof v === "string" && v.length > 0) ||
					(isB64(v) && v.$b64.length > 0))
			);
		})
		.map((c) => ({ column: c, size: utf8Length(literals.get(c.name)) }))
		.sort((a, b) => b.size - a.size);
	const split = [];
	for (const { column } of candidates) {
		if (utf8Length(sql) < maxStmt) {
			break;
		}
		literals.set(column.name, isB64(row[column.name]) ? "X''" : "''");
		split.push(column);
		sql = insert();
	}
	const where = `${ident(keyColumn)} = ${valueLiteral(row[keyColumn])}`;
	if (utf8Length(sql) >= maxStmt) {
		throw new Error(
			`restore: INSERT for ${table.name} ${where} is ${utf8Length(sql)} bytes even with every TEXT/BLOB value split`,
		);
	}
	const target = ident(table.name);
	const updates = [];
	for (const c of split) {
		const value = row[c.name];
		const col = ident(c.name);
		if (isB64(value)) {
			const room =
				maxStmt -
				1 -
				utf8Length(
					`UPDATE ${target} SET ${col} = CAST(${col} || X'' AS BLOB) WHERE ${where};`,
				);
			const step = Math.min(CHUNK_HEX, room - (room % 2));
			if (step < 2) {
				throw new Error(`restore: no room to append ${table.name}.${c.name}`);
			}
			const hex = bytesToHex(base64ToBytes(value.$b64));
			for (let i = 0; i < hex.length; i += step) {
				updates.push(
					`UPDATE ${target} SET ${col} = CAST(${col} || X'${hex.slice(i, i + step)}' AS BLOB) WHERE ${where};`,
				);
			}
			continue;
		}
		const room = Math.min(
			CHUNK_TEXT_BYTES,
			maxStmt -
				1 -
				utf8Length(
					`UPDATE ${target} SET ${col} = ${col} || '' WHERE ${where};`,
				),
		);
		if (room < 4) {
			throw new Error(`restore: no room to append ${table.name}.${c.name}`);
		}
		for (const chunk of textChunks(String(value), room)) {
			updates.push(
				`UPDATE ${target} SET ${col} = ${col} || '${chunk}' WHERE ${where};`,
			);
		}
	}
	return [sql, ...updates];
}

/**
 * Orphan report: dropped rows per table with a small sample.
 * @typedef {Record<string, { count: number, sample: unknown[], blob_bytes?: Record<string, number> }>} OrphanReport
 */

/**
 * Admits rows whose non-null FK parents were already admitted, so a
 * missing parent drops its whole subtree (deliveries, then attempts).
 * Tables must be fed in `tableOrder`. Before streaming a table's rows
 * through `admit`, call `preload` with that table's rows: a
 * self-referencing FK is then checked against the pre-collected key set,
 * so forward self-references (child streamed before its parent) admit.
 * Without a prior `preload`, self-references fall back to the keys seen
 * so far in the same table.
 * @param {Manifest} manifest
 * @returns {{ admit: (table: string | ManifestTable, row: Record<string, unknown>) => boolean, preload: (table: string | ManifestTable, rows: Iterable<Record<string, unknown>>) => void, report: () => OrphanReport }}
 */
export function createOrphanFilter(manifest) {
	const byName = new Map(manifest.tables.map((t) => [t.name, t]));
	/** Table -> admitted parent key values. */
	const admitted = new Map();
	/** Table -> key values seen so far (for self-referencing FKs). */
	const seen = new Map();
	/** Table -> pre-collected own key values (via `preload`). */
	const preloaded = new Map();
	/** Table -> { count, sample }. */
	const orphans = new Map();
	for (const t of manifest.tables) {
		admitted.set(t.name, new Set());
		seen.set(t.name, new Set());
		preloaded.set(t.name, new Set());
	}
	/**
	 * Resolve a table name or table object to its manifest entry.
	 * @param {string | ManifestTable} table
	 * @returns {ManifestTable}
	 */
	function resolve(table) {
		const info = typeof table === "string" ? byName.get(table) : table;
		if (!info) {
			throw new Error(
				`restore: unknown table ${typeof table === "string" ? table : "?"}`,
			);
		}
		return info;
	}
	/**
	 * The table's own key for a row.
	 * @param {ManifestTable} info
	 * @param {Record<string, unknown>} row
	 * @returns {unknown}
	 */
	function ownKeyOf(info, row) {
		return "column" in info.key
			? (row[info.key.column] ?? null)
			: JSON.stringify(row);
	}
	/**
	 * Pre-collect a table's own keys before streaming its rows through
	 * `admit`, so forward self-references admit. Additive: safe to call
	 * once per part batch.
	 * @param {string | ManifestTable} table
	 * @param {Iterable<Record<string, unknown>>} rows
	 * @returns {void}
	 */
	function preload(table, rows) {
		const info = resolve(table);
		const keys = preloaded.get(info.name);
		for (const row of rows) {
			keys.add(ownKeyOf(info, row));
		}
	}
	/**
	 * @param {string | ManifestTable} table
	 * @param {Record<string, unknown>} row
	 * @returns {boolean}
	 */
	function admit(table, row) {
		const info = resolve(table);
		const ownKey = ownKeyOf(info, row);
		seen.get(info.name).add(ownKey);
		for (const fk of info.foreign_keys) {
			const value = row[fk.column] ?? null;
			if (value === null || value === undefined) {
				continue;
			}
			if (fk.table === info.name) {
				// Self-reference: admit against the pre-collected key set
				// (forward references OK), falling back to keys seen so
				// far when `preload` was not called. The row itself was
				// just added to `seen` above.
				if (
					value === ownKey ||
					preloaded.get(info.name).has(value) ||
					seen.get(info.name).has(value)
				) {
					continue;
				}
			} else if (admitted.get(fk.table)?.has(value)) {
				continue;
			}
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
		admitted.get(info.name).add(ownKey);
		return true;
	}
	function report() {
		return Object.fromEntries(orphans);
	}
	return { admit, preload, report };
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
