#!/usr/bin/env node
/**
 * Verify a restored D1 database against the backup manifest in
 * `.restore/<backup_id>/`: the manifest's table rows equal the sum of its
 * part rows, integrity_check is ok, foreign_key_check is empty, every row
 * count matches the manifest minus orphans, every BLOB byte total matches
 * the manifest minus orphaned BLOBs, and the applied migrations match.
 * Prints a table and exits 1 on any difference.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { backupIdOf, verifyChecks } from "./lib/restore.mjs";
import { wranglerBin } from "./lib/wrangler-bin.mjs";

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
const outDir = join(process.cwd(), ".restore", backupIdOf(prefix));
const manifest = JSON.parse(
	readFileSync(join(outDir, "manifest.json"), "utf8"),
);
const orphansPath = join(outDir, "orphans.json");
const orphans = existsSync(orphansPath)
	? JSON.parse(readFileSync(orphansPath, "utf8"))
	: {};
const wrangler = wranglerBin();

/**
 * Run one read query against the restored database, parsed from
 * `wrangler d1 execute --json`.
 * @param {string} command
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function query(command) {
	const out = execFileSync(
		wrangler,
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

const checks = await verifyChecks({ manifest, orphans, query });
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
