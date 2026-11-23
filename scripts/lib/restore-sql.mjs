import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function ident(name) {
	return `"${name.replace(/"/g, '""')}"`;
}

function textLiteral(value) {
	return `'${value.replace(/'/g, "''")}'`;
}

function base64ToBytes(b64) {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}

function bytesToHex(bytes) {
	let out = "";
	for (const b of bytes) {
		out += b.toString(16).padStart(2, "0");
	}
	return out;
}

function isB64(value) {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof value.$b64 === "string"
	);
}

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

export function tableOrder(manifest) {
	const names = manifest.tables.map((t) => t.name);
	const known = new Set(names);
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

function findCycle(names, parents) {
	const state = new Map();
	const stack = [];
	const visit = (name) => {
		state.set(name, 1);
		stack.push(name);
		/* node:coverage ignore next */
		for (const p of parents.get(name) ?? []) {
			if (state.get(p) === 1) {
				return (
					/* node:coverage ignore next */
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
		/* node:coverage ignore next 3 */
	}
	return names.join(" -> ");
}

const CHUNK_HEX = 65536;

const CHUNK_TEXT_BYTES = 65536;

const utf8 = new TextEncoder();

export function utf8Length(s) {
	return utf8.encode(s).length;
}

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

function textChunks(value, budget) {
	const chunks = [];
	let chunk = "";
	let bytes = 0;
	for (const ch of value) {
		const quote = ch === "'";
		/* node:coverage ignore next */
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

export function orphanEntry(table, row) {
	const fk = {};
	for (const f of table.foreign_keys) {
		fk[f.column] = row[f.column] ?? null;
	}
	return {
		table: table.name,
		key:
			"column" in table.key
				? { [table.key.column]: row[table.key.column] ?? null }
				: null,
		fk,
	};
}

export function createOrphanFilter(manifest) {
	const byName = new Map(manifest.tables.map((t) => [t.name, t]));
	const admitted = new Map();
	for (const t of manifest.tables) {
		admitted.set(t.name, new Map());
	}
	for (const t of manifest.tables) {
		for (const fk of t.foreign_keys) {
			admitted.get(fk.table)?.set(fk.to, new Set());
		}
	}
	const preloaded = new Map();
	const orphans = new Map();
	function resolve(table) {
		const info = typeof table === "string" ? byName.get(table) : table;
		if (!info) {
			throw new Error(
				`restore: unknown table ${typeof table === "string" ? table : "?"}`,
			);
		}
		return info;
	}
	function ownKeyOf(info, row) {
		return "column" in info.key
			? (row[info.key.column] ?? null)
			: JSON.stringify(row);
	}
	function keyOnly(info, row) {
		const out = {};
		if ("column" in info.key) {
			out[info.key.column] = row[info.key.column] ?? null;
		}
		for (const fk of info.foreign_keys) {
			out[fk.column] = row[fk.column] ?? null;
		}
		for (const col of admitted.get(info.name).keys()) {
			out[col] = row[col] ?? null;
		}
		return out;
	}
	function parentsOk(info, row) {
		for (const fk of info.foreign_keys) {
			const value = row[fk.column] ?? null;
			if (value === null || fk.table === info.name) {
				continue;
			}
			if (!admitted.get(fk.table)?.get(fk.to)?.has(value)) {
				return false;
			}
		}
		return true;
	}
	function resolveOrphaned(info) {
		const pre = preloaded.get(info.name);
		if (pre.orphaned) {
			return pre.orphaned;
		}
		const selfFks = info.foreign_keys.filter((fk) => fk.table === info.name);
		const owners = new Map();
		for (const fk of selfFks) {
			if (!owners.has(fk.to)) {
				const byValue = new Map();
				for (const [key, rec] of pre.records) {
					const v = rec[fk.to] ?? null;
					if (v !== null) {
						byValue.set(v, key);
					}
				}
				owners.set(fk.to, byValue);
			}
		}
		const orphaned = new Set();
		const children = new Map();
		const queue = [];
		for (const [key, rec] of pre.records) {
			let bad = !parentsOk(info, rec);
			for (const fk of selfFks) {
				const v = rec[fk.column] ?? null;
				if (v === null) {
					continue;
				}
				const owner = owners.get(fk.to).get(v);
				if (owner === undefined) {
					bad = true;
				} else if (owner !== key) {
					let list = children.get(owner);
					if (!list) {
						list = [];
						children.set(owner, list);
					}
					list.push(key);
				}
			}
			if (bad) {
				orphaned.add(key);
				queue.push(key);
			}
		}
		while (queue.length > 0) {
			const key = queue.pop();
			for (const child of children.get(key) ?? []) {
				if (!orphaned.has(child)) {
					orphaned.add(child);
					queue.push(child);
				}
			}
		}
		pre.orphaned = orphaned;
		return orphaned;
	}
	function preload(table, rows) {
		const info = resolve(table);
		let pre = preloaded.get(info.name);
		if (!pre) {
			pre = { records: new Map(), orphaned: null };
			preloaded.set(info.name, pre);
		}
		pre.orphaned = null;
		for (const row of rows) {
			pre.records.set(ownKeyOf(info, row), keyOnly(info, row));
		}
	}
	function selfOkSoFar(info, row) {
		for (const fk of info.foreign_keys) {
			const value = row[fk.column] ?? null;
			if (value === null || fk.table !== info.name) {
				continue;
			}
			if (
				value !== (row[fk.to] ?? null) &&
				!admitted.get(info.name).get(fk.to)?.has(value)
			) {
				return false;
			}
		}
		return true;
	}
	function admit(table, row) {
		const info = resolve(table);
		const ownKey = ownKeyOf(info, row);
		const pre = preloaded.get(info.name);
		const ok =
			pre?.records.has(ownKey) === true
				? !resolveOrphaned(info).has(ownKey)
				: parentsOk(info, row) && selfOkSoFar(info, row);
		if (!ok) {
			let entry = orphans.get(info.name);
			if (!entry) {
				entry = { count: 0, sample: [] };
				orphans.set(info.name, entry);
			}
			entry.count += 1;
			if (entry.sample.length < 5) {
				entry.sample.push(orphanEntry(info, row));
			}
			return false;
		}
		for (const [col, values] of admitted.get(info.name)) {
			const v = row[col] ?? null;
			if (v !== null) {
				values.add(v);
			}
		}
		return true;
	}
	function report() {
		return Object.fromEntries(orphans);
	}
	return { admit, preload, report };
}

export class SqlFileWriter {
	constructor(dir, maxBytes = 50000000) {
		this.dir = dir;
		this.maxBytes = maxBytes;
		this.files = [];
		this.index = 0;
		this.current = null;
		this.currentBytes = 0;
		mkdirSync(dir, { recursive: true });
	}

	roll() {
		this.index += 1;
		const name = `${String(this.index).padStart(4, "0")}.sql`;
		this.current = join(this.dir, name);
		const header = "PRAGMA defer_foreign_keys = true;\n";
		writeFileSync(this.current, header);
		this.currentBytes = new TextEncoder().encode(header).length;
		this.files.push(this.current);
	}

	writeStatement(sql) {
		const line = sql.endsWith("\n") ? sql : `${sql}\n`;
		const size = new TextEncoder().encode(line).length;
		if (this.current === null || this.currentBytes + size > this.maxBytes) {
			this.roll();
		}
		appendFileSync(this.current, line);
		this.currentBytes += size;
	}

	close() {
		return this.files;
	}
}
