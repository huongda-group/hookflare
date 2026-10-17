#!/usr/bin/env node
/**
 * Restore an R2 backup into a new D1 database (path B). Refuses the
 * production database always and the staging database unless
 * `--allow-known-db`; refuses a target whose d1_migrations differ from
 * the manifest or that already has rows. Downloads and sha256-checks the
 * parts, streams them into SQL files in `tableOrder` (orphaned rows go to
 * `orphans.json`, key and FK values only), then applies each file with
 * `wrangler d1 execute --remote`, recording progress in
 * `.restore/<id>/applied.json` so a re-run resumes where it stopped.
 *
 * `--prepare-migrations` only copies the manifest's migrations into
 * `.restore/<id>/migrations/` for `wrangler d1 migrations apply`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	backupIdOf,
	prepareMigrations,
	restoreBackup,
} from "./lib/restore.mjs";
import { repoRoot, wranglerBin } from "./lib/wrangler-bin.mjs";

const USAGE = [
	"usage: restore-backup.mjs --prefix <p> --config <config> [--bucket hookflare-backups]",
	"                          [--dry-run] [--from NNNN] [--allow-known-db]",
	"       restore-backup.mjs --prefix <p> --prepare-migrations [--bucket hookflare-backups]",
].join("\n");

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

const argv = process.argv.slice(2);
const prefix = option(argv, "--prefix", "");
const config = option(argv, "--config", "");
const bucket = option(argv, "--bucket", "hookflare-backups");
const prepare = argv.includes("--prepare-migrations");
const fromArg = option(argv, "--from", "");
if (!prefix || (!config && !prepare) || (fromArg && !/^\d+$/.test(fromArg))) {
	console.error(USAGE);
	process.exit(1);
}
const wrangler = wranglerBin();

/**
 * Download one R2 object to a local file.
 * @param {string} key
 * @param {string} dest
 * @returns {Promise<void>}
 */
async function r2Get(key, dest) {
	mkdirSync(dirname(dest), { recursive: true });
	execFileSync(
		wrangler,
		["r2", "object", "get", `${bucket}/${key}`, "--file", dest, "--remote"],
		{ stdio: "inherit" },
	);
}

/**
 * Run one read query on the target database.
 * @param {string} sql
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function query(sql) {
	const out = execFileSync(
		wrangler,
		[
			"d1",
			"execute",
			"DB",
			"--remote",
			"--json",
			"--command",
			sql,
			"--config",
			config,
		],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	const parsed = JSON.parse(out);
	const first = Array.isArray(parsed) ? parsed[0] : parsed;
	return first.results ?? [];
}

/**
 * Apply one SQL file to the target database.
 * @param {string} file
 * @returns {Promise<void>}
 */
async function execute(file) {
	execFileSync(
		wrangler,
		["d1", "execute", "DB", "--remote", "--file", file, "--config", config],
		{ stdio: "inherit" },
	);
}

try {
	if (prepare) {
		const outDir = join(process.cwd(), ".restore", backupIdOf(prefix));
		const manifestPath = join(outDir, "manifest.json");
		await r2Get(`${prefix}manifest.json`, manifestPath);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		const migrationsDir = join(outDir, "migrations");
		const copied = prepareMigrations(
			manifest,
			join(repoRoot, "apps", "gateway", "migrations"),
			migrationsDir,
		);
		console.log(
			`restore: copied ${copied.length} migration(s), last ${copied[copied.length - 1] ?? "-"}`,
		);
		console.log(
			`restore: set "migrations_dir": "${migrationsDir}" in the restore config's d1_databases entry`,
		);
	} else {
		await restoreBackup(
			{
				prefix,
				config,
				dryRun: argv.includes("--dry-run"),
				allowKnownDb: argv.includes("--allow-known-db"),
				from: fromArg ? Number(fromArg) : null,
				cwd: process.cwd(),
				productionConfig: join(repoRoot, "apps", "gateway", "wrangler.jsonc"),
				stagingConfig: join(
					repoRoot,
					"apps",
					"gateway",
					"wrangler.staging.jsonc",
				),
			},
			{ r2Get, query, execute, log: (m) => console.log(m) },
		);
	}
} catch (err) {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
}
