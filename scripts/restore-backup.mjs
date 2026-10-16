#!/usr/bin/env node
/**
 * Restore an R2 backup into a D1 database: download the manifest and parts
 * for `--prefix`, verify every sha256, generate SQL table by table in
 * `tableOrder` (orphaned rows go to `orphans.json`, not the database),
 * and apply each SQL file with `wrangler d1 execute --remote` unless
 * `--dry-run` is passed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
	createOrphanFilter,
	rowStatements,
	SqlFileWriter,
	tableOrder,
} from "./lib/restore-sql.mjs";

/**
 * CLI options.
 * @typedef {{ prefix: string, config: string, bucket: string, dryRun: boolean }} RestoreOptions
 */

/**
 * Value of a `--flag value` argv option.
 * @param {string[]} argv
 * @param {string} flag
 * @param {string} fallback
 * @returns {string}
 */
function option(argv, flag, fallback) {
	const index = argv.indexOf(flag);
	return index !== -1 && index + 1 < argv.length ? argv[index + 1] : fallback;
}

/**
 * Parse argv. `--prefix` and `--config` are required.
 * @param {string[]} argv
 * @returns {RestoreOptions}
 */
function parseArgs(argv) {
	const prefix = option(argv, "--prefix", "");
	const config = option(argv, "--config", "");
	if (!prefix || !config) {
		console.error(
			"usage: restore-backup.mjs --prefix <p> --config <config> [--bucket hookflare-backups] [--dry-run]",
		);
		process.exit(1);
	}
	return {
		prefix,
		config,
		bucket: option(argv, "--bucket", "hookflare-backups"),
		dryRun: argv.includes("--dry-run"),
	};
}

/**
 * The backup id is the last path segment of the prefix
 * (`d1/2026/10/16/<id>/` -> `<id>`).
 * @param {string} prefix
 * @returns {string}
 */
function backupIdOf(prefix) {
	const segments = prefix.split("/").filter((s) => s.length > 0);
	if (segments.length === 0) {
		throw new Error(`restore: bad prefix ${prefix}`);
	}
	return segments[segments.length - 1];
}

/**
 * Download one R2 object to a local file.
 * @param {string} bucket
 * @param {string} key
 * @param {string} dest
 * @returns {void}
 */
function r2Get(bucket, key, dest) {
	mkdirSync(dirname(dest), { recursive: true });
	execFileSync(
		"wrangler",
		["r2", "object", "get", `${bucket}/${key}`, "--file", dest, "--remote"],
		{ stdio: "inherit" },
	);
}

/**
 * Hex sha256 of a file. Stops the restore on the first mismatch.
 * @param {string} path
 * @param {string} expected
 * @param {string} what
 * @returns {void}
 */
function checkSha256(path, expected, what) {
	const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
	if (actual !== expected.toLowerCase()) {
		throw new Error(`restore: sha256 mismatch for ${what}`);
	}
}

/**
 * Rows of a gzipped NDJSON part.
 * @param {string} path
 * @returns {Record<string, unknown>[]}
 */
function readPartRows(path) {
	const text = gunzipSync(readFileSync(path)).toString("utf8");
	const rows = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) {
			continue;
		}
		rows.push(JSON.parse(line));
	}
	return rows;
}

/**
 * Decoded BLOB byte counts per BLOB column of a row.
 * @param {{ columns: { name: string, blob: boolean }[] }} table
 * @param {Record<string, unknown>} row
 * @returns {Record<string, number>}
 */
function rowBlobBytes(table, row) {
	const out = {};
	for (const c of table.columns) {
		if (!c.blob) {
			continue;
		}
		const value = row[c.name] ?? null;
		if (typeof value === "object" && value !== null && "$b64" in value) {
			const b64 = /** @type {{ $b64: string }} */ (value).$b64;
			const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
			out[c.name] = (b64.length * 3) / 4 - pad;
		}
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const backupId = backupIdOf(args.prefix);
const outDir = join(process.cwd(), ".restore", backupId);
const sqlDir = join(outDir, "sql");
mkdirSync(outDir, { recursive: true });

const manifestKey = `${args.prefix}manifest.json`;
const manifestPath = join(outDir, "manifest.json");
console.log(`restore: downloading ${manifestKey}`);
r2Get(args.bucket, manifestKey, manifestPath);
/** @type {import("./lib/restore-sql.mjs").Manifest} */
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const filter = createOrphanFilter(manifest);
const writer = new SqlFileWriter(sqlDir);
/** @type {Record<string, { count: number, sample: unknown[], blob_bytes: Record<string, number> }>} */
const orphans = {};
let restored = 0;
for (const name of tableOrder(manifest)) {
	const table = manifest.tables.find((t) => t.name === name);
	for (const part of table.parts) {
		const dest = join(outDir, part.key);
		if (!existsSync(dest)) {
			console.log(`restore: downloading ${part.key}`);
			r2Get(args.bucket, part.key, dest);
		}
		checkSha256(dest, part.sha256, part.key);
		for (const row of readPartRows(dest)) {
			if (!filter.admit(table, row)) {
				let entry = orphans[name];
				if (!entry) {
					entry = { count: 0, sample: [], blob_bytes: {} };
					orphans[name] = entry;
				}
				entry.count += 1;
				if (entry.sample.length < 5) {
					entry.sample.push(row);
				}
				for (const [col, n] of Object.entries(rowBlobBytes(table, row))) {
					entry.blob_bytes[col] = (entry.blob_bytes[col] ?? 0) + n;
				}
				continue;
			}
			for (const stmt of rowStatements(table, row)) {
				writer.writeStatement(stmt);
			}
			restored += 1;
		}
	}
}
const files = writer.close();
const report = filter.report();
for (const [name, entry] of Object.entries(report)) {
	orphans[name] = {
		count: entry.count,
		sample: entry.sample,
		blob_bytes: orphans[name]?.blob_bytes ?? {},
	};
}
writeFileSync(join(outDir, "orphans.json"), JSON.stringify(orphans, null, 2));
console.log(`restore: ${restored} rows -> ${files.length} SQL files`);

if (!args.dryRun) {
	for (const file of files) {
		console.log(`restore: applying ${file}`);
		execFileSync(
			"wrangler",
			[
				"d1",
				"execute",
				"DB",
				"--remote",
				"--file",
				file,
				"--config",
				args.config,
			],
			{ stdio: "inherit" },
		);
	}
}
console.log(
	`restore: done (orphans: ${Object.values(orphans).reduce((s, o) => s + o.count, 0)})`,
);
