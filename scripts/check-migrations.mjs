#!/usr/bin/env node
/**
 * Block destructive migrations outside the contract list. Compares the
 * migration files in the working tree against the base ref and fails when a
 * new migration is destructive without a contract entry.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMigrations, newMigrations } from "./lib/migrations.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(repoRoot, "apps", "gateway", "migrations");
const contractPath = join(migrationsDir, "contract.json");

/**
 * Parse `--base <ref>` from argv.
 * @param {string[]} argv
 * @returns {string}
 */
function parseBase(argv) {
	const index = argv.indexOf("--base");
	if (index !== -1 && index + 1 < argv.length) {
		return argv[index + 1];
	}
	return "origin/main";
}

/**
 * List migration paths tracked at a base ref.
 * @param {string} base
 * @returns {string[]}
 */
function listBaseFiles(base) {
	try {
		const out = execFileSync(
			"git",
			["ls-tree", "--name-only", base, "apps/gateway/migrations/"],
			{ cwd: repoRoot, encoding: "utf8" },
		);
		return out
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	} catch {
		console.error(
			`error: base ref "${base}" is missing (fork or shallow checkout); ` +
				`fetch full history or pass --base <ref>.`,
		);
		process.exit(1);
	}
}

const base = parseBase(process.argv.slice(2));
const baseFiles = listBaseFiles(base);
const headFiles = readdirSync(migrationsDir).filter((name) =>
	name.endsWith(".sql"),
);
const fresh = newMigrations(baseFiles, headFiles);
if (fresh.length === 0) {
	console.log("0 new migrations");
	process.exit(0);
}
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const result = checkMigrations({
	files: fresh.map((name) => ({
		name,
		sql: readFileSync(join(migrationsDir, name), "utf8"),
	})),
	contract,
});
if (!result.ok) {
	for (const problem of result.problems) {
		console.error(`${problem.file}: ${problem.reasons.join(", ")}`);
	}
	process.exit(1);
}
console.log(`ok: ${fresh.length} new migration(s), none destructive`);
