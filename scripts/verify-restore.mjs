#!/usr/bin/env node
/**
 * Verify a restored D1 database against the backup manifest in
 * `.restore/<backup_id>/`: integrity_check is ok, foreign_key_check is
 * empty, every row count matches the manifest minus orphans, every BLOB
 * byte total matches the manifest minus orphaned BLOBs, and the applied
 * migrations match. Prints a table and exits 1 on any difference.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

const prefix = option(process.argv.slice(2), "--prefix", "");
const config = option(process.argv.slice(2), "--config", "");
if (!prefix || !config) {
	console.error("usage: verify-restore.mjs --prefix <p> --config <config>");
	process.exit(1);
}
const segments = prefix.split("/").filter((s) => s.length > 0);
const backupId = segments[segments.length - 1];
const outDir = join(process.cwd(), ".restore", backupId);
const manifest = JSON.parse(
	readFileSync(join(outDir, "manifest.json"), "utf8"),
);
const orphansPath = join(outDir, "orphans.json");
/** @type {Record<string, { count: number, blob_bytes?: Record<string, number> }>} */
const orphans = existsSync(orphansPath)
	? JSON.parse(readFileSync(orphansPath, "utf8"))
	: {};

/**
 * Quote an identifier with `"` doubled.
 * @param {string} s
 * @returns {string}
 */
function ident(s) {
	return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Run one read query against the restored database, parsed from
 * `wrangler d1 execute --json`.
 * @param {string} command
 * @returns {Record<string, unknown>[]}
 */
function d1All(command) {
	const out = execFileSync(
		"wrangler",
		[
			"d1",
			"execute",
			"DB",
			"--remote",
			"--json",
			"--command",
			command,
			"--config",
			config,
		],
		{ encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
	);
	const parsed = JSON.parse(out);
	const first = Array.isArray(parsed) ? parsed[0] : parsed;
	return first.results ?? [];
}

/** @type {{ check: string, expected: string, actual: string, ok: boolean }[]} */
const checks = [];
/**
 * @param {string} check
 * @param {unknown} expected
 * @param {unknown} actual
 * @returns {void}
 */
function check(check, expected, actual) {
	const exp = JSON.stringify(expected);
	const got = JSON.stringify(actual);
	checks.push({ check, expected: exp, actual: got, ok: exp === got });
}

const integrity = d1All("PRAGMA integrity_check");
check(
	"integrity_check",
	"ok",
	integrity.length === 1 ? Object.values(integrity[0])[0] : integrity,
);
const fk = d1All("PRAGMA foreign_key_check");
check("foreign_key_check", [], fk);

for (const table of manifest.tables) {
	const name = table.name;
	const rows = d1All(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`);
	const expected = table.rows - (orphans[name]?.count ?? 0);
	check(`rows ${name}`, expected, rows[0]?.n ?? null);
	for (const col of table.columns.filter((c) => c.blob)) {
		const sums = d1All(
			`SELECT SUM(LENGTH(${ident(col.name)})) AS s FROM ${ident(name)}`,
		);
		const recorded = table.parts.reduce(
			(t, p) => t + (p.blob_bytes[col.name] ?? 0),
			0,
		);
		const dropped = orphans[name]?.blob_bytes?.[col.name] ?? 0;
		check(
			`blob_bytes ${name}.${col.name}`,
			recorded - dropped,
			sums[0]?.s ?? 0,
		);
	}
}

const applied = d1All("SELECT name FROM d1_migrations ORDER BY id");
check(
	"d1_migrations",
	manifest.d1_migrations,
	applied.map((r) => r.name),
);

const width = Math.max(...checks.map((c) => c.check.length));
for (const c of checks) {
	console.log(
		`${c.ok ? "ok  " : "FAIL"} ${c.check.padEnd(width)} expected=${c.expected} actual=${c.actual}`,
	);
}
const failed = checks.filter((c) => !c.ok);
if (failed.length > 0) {
	console.error(`verify: ${failed.length} check(s) failed`);
	process.exit(1);
}
console.log("verify: all checks passed");
