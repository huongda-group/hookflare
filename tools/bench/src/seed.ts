/**
 * M6 dataset seeder: `node src/seed.ts --n 1000000 --project <id>
 * --source <id> --destination <id> [--big] [--days 30] [--seed <uint32>]
 * --config <staging config>`.
 *
 * Generates synthetic `webhook_events`, `deliveries`, and
 * `delivery_attempts` rows (payload mix 1 KB / 8 KB / 32 KB, or 10% at
 * 33–42 KB under `--big`; final statuses 96% delivered / 3% failed_final /
 * 1% dead; `created_at` spread over `--days`), and streams them as
 * multi-row `INSERT` files under `tools/bench/results/seed-NNN.sql`. Memory
 * stays bounded by one statement per table, independent of `--n`.
 *
 * Node 24 runs this file directly through type stripping. The gateway never
 * imports it; row IDs use the gateway `<prefix>_<ULID>` format.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	readdirSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { newId } from "../../../apps/gateway/src/core/ids.ts";

export type SeedRow = {
	table: string;
	row: Record<string, unknown>;
};

export type SeedGenOptions = {
	/** IDs the rows belong to. Generated in gateway format when omitted. */
	projectId?: string;
	sourceId?: string;
	destinationId?: string;
	/** How many trailing days `created_at` spreads over. Default 30. */
	days?: number;
	/** When true, 10% of payloads are 33–42 KB. Default false. */
	big?: boolean;
};

/** Columns whose string values are BLOB hex rendered as `X'…'`. */
const BLOB_COLUMNS: Record<string, Set<string>> = {
	webhook_events: new Set(["body_inline"]),
};

/** Parent tables first so file order respects foreign keys. */
const TABLE_ORDER = ["webhook_events", "deliveries", "delivery_attempts"];

/** Every emitted INSERT stays strictly below this many bytes. */
export const STATEMENT_LIMIT = 90_000;

/**
 * The `--big` bucket: above 32 KB, but at most 42 KB so the hex literal
 * (2 chars per byte) plus the other columns stays under STATEMENT_LIMIT.
 */
const BIG_MIN = 33 * 1024;
const BIG_MAX = 42 * 1024;

/** mulberry32: small, fast, seedable PRNG returning [0, 1). */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pickSize(roll: number, big: boolean, rng: () => number): number {
	if (big) {
		if (roll < 0.6) return 1024;
		if (roll < 0.8) return 8192;
		if (roll < 0.9) return 32768;
		return BIG_MIN + Math.floor(rng() * (BIG_MAX - BIG_MIN + 1));
	}
	if (roll < 0.7) return 1024;
	if (roll < 0.95) return 8192;
	return 32768;
}

function hexByte(rand: () => number): string {
	return Math.floor(rand() * 256)
		.toString(16)
		.padStart(2, "0");
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Base32-encode a non-negative integer below 2^(5·chars), zero-padded. */
function encodeBase32(value: number, chars: number): string {
	let v = value;
	let out = "";
	for (let i = 0; i < chars; i++) {
		out = CROCKFORD[v % 32] + out;
		v = Math.floor(v / 32);
	}
	return out;
}

const SEQ_SPACE = 2 ** 40;

/**
 * `<prefix>_<ULID>` whose time component is exactly `ms` (unlike the
 * gateway's monotonic `newId`, which holds the clock when timestamps go
 * backwards). The 80-bit random part is a 40-bit per-run nonce followed by
 * a 40-bit per-prefix sequence number, so IDs are unique within a run.
 */
export function seedId(
	prefix: string,
	ms: number,
	nonce: number,
	seq: number,
): string {
	if (!Number.isInteger(seq) || seq < 0 || seq >= SEQ_SPACE) {
		throw new Error("seed: id sequence out of range");
	}
	return `${prefix}_${encodeBase32(ms, 10)}${encodeBase32(nonce, 8)}${encodeBase32(seq, 8)}`;
}

/**
 * One event, one delivery, and 1–3 attempts per event. `rng` drives every
 * mix decision (payload size, status, timestamps) and the ID nonce, so a
 * seed reproduces the dataset. `at` is the newest `created_at` in ms.
 */
export function* seedRows(
	n: number,
	rng: () => number,
	at: number,
	opts: SeedGenOptions = {},
): Iterable<SeedRow> {
	const days = opts.days ?? 30;
	const big = opts.big ?? false;
	const spanMs = days * 86_400_000;
	const projectId = opts.projectId ?? newId("prj", at);
	const sourceId = opts.sourceId ?? newId("src", at);
	const destinationId = opts.destinationId ?? newId("dst", at);
	const batch = `seed-${at.toString(36)}`;
	const nonce = Math.floor(rng() * SEQ_SPACE);

	for (let i = 0; i < n; i++) {
		const createdAt = at - Math.floor(rng() * spanMs);
		const sizeBytes = pickSize(rng(), big, rng);

		// A 64-byte random tile keeps large-scale generation fast while every
		// row still carries exactly `sizeBytes` of payload.
		let tile = "";
		for (let t = 0; t < 64; t++) tile += hexByte(rng);
		const bodyHex = tile
			.repeat(Math.ceil((sizeBytes * 2) / tile.length))
			.slice(0, sizeBytes * 2);
		const payloadSha256 = createHash("sha256")
			.update(bodyHex, "hex")
			.digest("hex");

		const eventId = seedId("evt", createdAt, nonce, i);
		const deliveryId = seedId("dlv", createdAt, nonce, i);

		yield {
			table: "webhook_events",
			row: {
				id: eventId,
				project_id: projectId,
				source_id: sourceId,
				provider_event_id: `${batch}-${i}`,
				received_at: createdAt,
				headers_json: JSON.stringify({
					"content-type": "application/json",
					"user-agent": "hookflare-seed",
				}),
				content_type: "application/json",
				size_bytes: sizeBytes,
				payload_sha256: payloadSha256,
				body_inline: bodyHex,
				r2_key: null,
				archive_batch_id: null,
				archive_part: null,
			},
		};

		const statusRoll = rng();
		const status =
			statusRoll < 0.96
				? "delivered"
				: statusRoll < 0.99
					? "failed_final"
					: "dead";
		const attemptCount = 1 + Math.floor(rng() * 3);

		yield {
			table: "deliveries",
			row: {
				id: deliveryId,
				event_id: eventId,
				destination_id: destinationId,
				project_id: projectId,
				kind: "initial",
				status,
				attempt_count: attemptCount,
				enqueued_at: createdAt,
				next_attempt_at: null,
				lease_until: null,
				last_http_status: status === "delivered" ? 200 : 500,
				last_error: status === "delivered" ? null : "seed failure",
				completed_at: createdAt + attemptCount * 400,
				created_by: "seed",
				created_at: createdAt,
			},
		};

		for (let a = 1; a <= attemptCount; a++) {
			const last = a === attemptCount;
			const ok = last && status === "delivered";
			const startedAt = createdAt + a * 400;
			yield {
				table: "delivery_attempts",
				row: {
					id: seedId("att", startedAt, nonce, i * 4 + a),
					delivery_id: deliveryId,
					attempt_no: a,
					started_at: startedAt,
					duration_ms: 40 + Math.floor(rng() * 400),
					http_status: ok ? 200 : 500,
					error_kind: ok ? null : "http_5xx",
					error_message: ok ? null : "seed: upstream 500",
					response_snippet: null,
				},
			};
		}
	}
}

function sqlValue(table: string, column: string, value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number") return String(value);
	if (typeof value === "boolean") return value ? "1" : "0";
	if (typeof value === "string") {
		if (BLOB_COLUMNS[table]?.has(column)) return `X'${value}'`;
		return `'${value.replace(/'/g, "''")}'`;
	}
	throw new Error(`seed: unsupported value for ${table}.${column}`);
}

export type SqlFileOptions = {
	/** Upper bound for one file in bytes. Default 50,000,000. */
	maxBytes?: number;
	/** Output directory (with trailing slash). Default `tools/bench/results/`. */
	dir?: string;
};

export type SqlFileResult = {
	/** Written file paths in load order (parents first). */
	files: string[];
	/** Rows written per table. */
	rows: Record<string, number>;
	/** Total bytes across all files. */
	bytes: number;
};

const SEED_FILE = /^seed-\d{3,}\.sql$/;
const PART_FILE = /^\.seed-part-.*\.sql$/;

/**
 * One table's open statement and part files. Holds at most one statement
 * worth of tuples, so memory does not grow with the row count.
 */
class TableWriter {
	readonly parts: string[] = [];
	rows = 0;
	bytes = 0;
	private readonly columns: string[];
	private readonly prefix: string;
	private readonly prefixBytes: number;
	private tuples: string[] = [];
	private statementBytes = 0;
	private fd: number | null = null;
	private fileBytes = 0;
	// Plain fields, not parameter properties: Node's type stripping rejects
	// those.
	private readonly table: string;
	private readonly dir: string;
	private readonly tag: string;
	private readonly maxBytes: number;

	constructor(
		table: string,
		firstRow: Record<string, unknown>,
		dir: string,
		tag: string,
		maxBytes: number,
	) {
		this.table = table;
		this.dir = dir;
		this.tag = tag;
		this.maxBytes = maxBytes;
		this.columns = Object.keys(firstRow);
		this.prefix = `INSERT INTO ${table} (${this.columns.join(", ")}) VALUES `;
		this.prefixBytes = Buffer.byteLength(this.prefix, "utf8");
	}

	add(row: Record<string, unknown>): void {
		const tuple = `(${this.columns.map((c) => sqlValue(this.table, c, row[c])).join(", ")})`;
		const tupleBytes = Buffer.byteLength(tuple, "utf8");
		// Statement = prefix + tuples joined by ", " + ";".
		if (
			this.tuples.length > 0 &&
			this.statementBytes + 2 + tupleBytes >= STATEMENT_LIMIT
		) {
			this.flushStatement();
		}
		if (this.tuples.length === 0) {
			this.statementBytes = this.prefixBytes + tupleBytes + 1;
			if (this.statementBytes >= STATEMENT_LIMIT) {
				throw new Error(
					`seed: single ${this.table} row exceeds the 90 KB statement limit`,
				);
			}
		} else {
			this.statementBytes += 2 + tupleBytes;
		}
		this.tuples.push(tuple);
		this.rows++;
	}

	flushStatement(): void {
		if (this.tuples.length === 0) return;
		const line = `${this.prefix}${this.tuples.join(", ")};\n`;
		const lineBytes = this.statementBytes + 1;
		this.tuples = [];
		this.statementBytes = 0;
		if (this.fd !== null && this.fileBytes + lineBytes > this.maxBytes) {
			this.closeFile();
		}
		if (this.fd === null) {
			const part = `${this.dir}.seed-part-${this.tag}-${this.parts.length.toString().padStart(6, "0")}.sql`;
			this.fd = openSync(part, "w");
			this.parts.push(part);
		}
		writeSync(this.fd, line);
		this.fileBytes += lineBytes;
		this.bytes += lineBytes;
	}

	closeFile(): void {
		if (this.fd === null) return;
		closeSync(this.fd);
		this.fd = null;
		this.fileBytes = 0;
	}

	finish(): void {
		this.flushStatement();
		this.closeFile();
	}
}

function clearSeedFiles(dir: string): void {
	for (const name of readdirSync(dir)) {
		if (SEED_FILE.test(name) || PART_FILE.test(name)) {
			unlinkSync(`${dir}${name}`);
		}
	}
}

/**
 * Stream rows into multi-row INSERT statements (each under 90 KB), one
 * part-file sequence per table, then rename the parts parents-first into
 * `seed-001.sql`, `seed-002.sql`, … with at most `maxBytes` per file. Old
 * `seed-NNN.sql` files in `dir` are removed first.
 */
export function writeSqlFiles(
	rows: Iterable<SeedRow>,
	opts: SqlFileOptions = {},
): SqlFileResult {
	const maxBytes = opts.maxBytes ?? 50_000_000;
	const dir = opts.dir ?? new URL("../results/", import.meta.url).pathname;
	mkdirSync(dir, { recursive: true });
	clearSeedFiles(dir);

	const writers = new Map<string, TableWriter>();
	try {
		for (const r of rows) {
			let writer = writers.get(r.table);
			if (!writer) {
				writer = new TableWriter(
					r.table,
					r.row,
					dir,
					writers.size.toString(),
					maxBytes,
				);
				writers.set(r.table, writer);
			}
			writer.add(r.row);
		}
		for (const writer of writers.values()) writer.finish();
	} catch (err) {
		for (const writer of writers.values()) writer.closeFile();
		clearSeedFiles(dir);
		throw err;
	}

	const ordered = [
		...TABLE_ORDER.filter((t) => writers.has(t)),
		...[...writers.keys()].filter((t) => !TABLE_ORDER.includes(t)),
	];
	const files: string[] = [];
	const counts: Record<string, number> = {};
	let bytes = 0;
	for (const table of ordered) {
		const writer = writers.get(table) as TableWriter;
		counts[table] = writer.rows;
		bytes += writer.bytes;
		for (const part of writer.parts) {
			const index = (files.length + 1).toString().padStart(3, "0");
			const file = `${dir}seed-${index}.sql`;
			renameSync(part, file);
			files.push(file);
		}
	}
	return { files, rows: counts, bytes };
}

/**
 * `writeSqlFiles` into `tools/bench/results/` returning only the file
 * paths in load order.
 */
export function toSqlFiles(
	rows: Iterable<SeedRow>,
	maxBytes: number = 50_000_000,
): string[] {
	return writeSqlFiles(rows, { maxBytes }).files;
}

function flag(argv: string[], name: string): string | null {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

function has(argv: string[], name: string): boolean {
	return argv.includes(`--${name}`);
}

/** A random uint32 for `--seed` when none is given. */
export function randomSeed(): number {
	return randomBytes(4).readUInt32BE(0);
}

export async function main(argv: string[]): Promise<void> {
	const n = Number(flag(argv, "n") ?? "NaN");
	const projectId = flag(argv, "project") ?? "";
	const sourceId = flag(argv, "source") ?? "";
	const destinationId = flag(argv, "destination") ?? "";
	const config = flag(argv, "config") ?? "";
	const days = Number(flag(argv, "days") ?? "30");
	const seedFlag = flag(argv, "seed");
	const seed = seedFlag === null ? randomSeed() : Number(seedFlag);
	const big = has(argv, "big");
	if (
		!Number.isInteger(n) ||
		n < 1 ||
		!projectId ||
		!sourceId ||
		!destinationId ||
		!config ||
		!Number.isInteger(days) ||
		days < 1 ||
		!Number.isInteger(seed) ||
		seed < 0 ||
		seed > 0xffffffff
	) {
		console.error(
			"usage: node src/seed.ts --n <events> --project <id> --source <id> --destination <id> [--big] [--days 30] [--seed <uint32>] --config <wrangler config>",
		);
		return process.exit(2);
	}
	console.error(`seed: --seed ${seed}`);
	const at = Date.now();
	const rows = seedRows(n, mulberry32(seed), at, {
		projectId,
		sourceId,
		destinationId,
		days,
		big,
	});
	const files = toSqlFiles(rows);
	console.error(`seed: wrote ${n} events to ${files.length} file(s)`);
	for (const file of files) {
		console.error(`seed: loading ${file}`);
		execFileSync(
			"wrangler",
			["d1", "execute", "DB", "--remote", "--config", config, "--file", file],
			{ stdio: "inherit" },
		);
	}
	console.error("seed: done");
}

const invoked = (process.argv[1] ?? "")
	.replace(/\\/g, "/")
	.endsWith("/seed.ts");
if (invoked) {
	await main(process.argv.slice(2));
}
