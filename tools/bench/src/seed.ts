/**
 * M6 dataset seeder: `node src/seed.ts --n 1000000 --project <id>
 * --source <id> --destination <id> [--big] [--days 30]
 * --config <staging config>`.
 *
 * Generates synthetic `webhook_events`, `deliveries`, and
 * `delivery_attempts` rows (payload mix 1 KB / 8 KB / 32 KB, final statuses
 * 96% delivered / 3% failed_final / 1% dead, `created_at` spread over
 * `--days`), writes them as multi-row `INSERT` files under
 * `tools/bench/results/seed-NNN.sql`, then loads each file in order with
 * `wrangler d1 execute DB --remote --file`. Remote loads change staging and
 * cost time/money, so running them is a deliberate manual step.
 *
 * Node 24 runs this file directly through type stripping. The gateway never
 * imports it; row IDs reuse the gateway format through a relative import.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
	/** When true, 10% of payloads are above 32 KB. Default false. */
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

function pickSize(roll: number, big: boolean): number {
	if (big) {
		if (roll < 0.6) return 1024;
		if (roll < 0.8) return 8192;
		if (roll < 0.9) return 32768;
		// Above 32 KB but small enough that hex still fits one statement.
		return 40960;
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

/**
 * One event, one delivery, and 1–3 attempts per event. `rng` drives every
 * mix decision (payload size, status, timestamps); row IDs come from the
 * gateway format. `at` is the newest `created_at` in ms.
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

	for (let i = 0; i < n; i++) {
		const createdAt = at - Math.floor(rng() * spanMs);
		const sizeBytes = pickSize(rng(), big);

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

		const eventId = newId("evt", createdAt);
		const deliveryId = newId("dlv", createdAt);

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
			yield {
				table: "delivery_attempts",
				row: {
					id: newId("att", createdAt),
					delivery_id: deliveryId,
					attempt_no: a,
					started_at: createdAt + a * 400,
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

function statementByteLength(statement: string): number {
	return new TextEncoder().encode(statement).length;
}

/**
 * Pack rows into multi-row INSERT statements (each under 90 KB) grouped by
 * table, parents first, and write them to
 * `tools/bench/results/seed-NNN.sql` with at most `maxBytes` per file.
 * Returns the written file paths in load order.
 */
export function toSqlFiles(
	rows: Iterable<SeedRow>,
	maxBytes: number = 50_000_000,
): string[] {
	const byTable = new Map<string, Record<string, unknown>[]>();
	for (const r of rows) {
		const list = byTable.get(r.table) ?? [];
		list.push(r.row);
		byTable.set(r.table, list);
	}
	const ordered = [
		...TABLE_ORDER.filter((t) => byTable.has(t)),
		...[...byTable.keys()].filter((t) => !TABLE_ORDER.includes(t)),
	];

	const statements: string[] = [];
	for (const table of ordered) {
		const tableRows = byTable.get(table) ?? [];
		if (tableRows.length === 0) continue;
		const columns = Object.keys(tableRows[0] as Record<string, unknown>);
		const prefix = `INSERT INTO ${table} (${columns.join(", ")}) VALUES `;
		let batch: string[] = [];
		const flush = () => {
			if (batch.length > 0) {
				statements.push(`${prefix}${batch.join(", ")};`);
				batch = [];
			}
		};
		for (const row of tableRows) {
			const tuple = `(${columns.map((c) => sqlValue(table, c, row[c])).join(", ")})`;
			const probe = `${prefix}${[...batch, tuple].join(", ")};`;
			if (batch.length > 0 && statementByteLength(probe) >= STATEMENT_LIMIT) {
				flush();
			}
			batch.push(tuple);
			if (
				statementByteLength(`${prefix}${batch.join(", ")};`) >= STATEMENT_LIMIT
			) {
				throw new Error(
					`seed: single ${table} row exceeds the 90 KB statement limit`,
				);
			}
		}
		flush();
	}

	const dir = new URL("../results/", import.meta.url).pathname;
	mkdirSync(dir, { recursive: true });
	const files: string[] = [];
	let current: string[] = [];
	let currentBytes = 0;
	const flushFile = () => {
		if (current.length === 0) return;
		const index = (files.length + 1).toString().padStart(3, "0");
		const file = `${dir}seed-${index}.sql`;
		writeFileSync(file, `${current.join("\n")}\n`, "utf8");
		files.push(file);
		current = [];
		currentBytes = 0;
	};
	for (const statement of statements) {
		const size = statementByteLength(`${statement}\n`);
		if (current.length > 0 && currentBytes + size > maxBytes) flushFile();
		current.push(statement);
		currentBytes += size;
	}
	flushFile();
	return files;
}

function flag(argv: string[], name: string): string | null {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

function has(argv: string[], name: string): boolean {
	return argv.includes(`--${name}`);
}

export async function main(argv: string[]): Promise<void> {
	const n = Number(flag(argv, "n") ?? "NaN");
	const projectId = flag(argv, "project") ?? "";
	const sourceId = flag(argv, "source") ?? "";
	const destinationId = flag(argv, "destination") ?? "";
	const config = flag(argv, "config") ?? "";
	const days = Number(flag(argv, "days") ?? "30");
	const big = has(argv, "big");
	if (
		!Number.isInteger(n) ||
		n < 1 ||
		!projectId ||
		!sourceId ||
		!destinationId ||
		!config ||
		!Number.isInteger(days) ||
		days < 1
	) {
		console.error(
			"usage: node src/seed.ts --n <events> --project <id> --source <id> --destination <id> [--big] [--days 30] --config <wrangler config>",
		);
		return process.exit(2);
	}
	let state = (n ^ 0x9e3779b9) >>> 0;
	const rng = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const at = Date.now();
	const rows = seedRows(n, rng, at, {
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
