#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	changedMigrations,
	checkMigrations,
	contractProblems,
	newMigrations,
} from "./lib/migrations.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(repoRoot, "apps", "gateway", "migrations");
const contractPath = join(migrationsDir, "contract.json");
const squashedPath = join(migrationsDir, "squashed.json");

function parseBase(argv) {
	const index = argv.indexOf("--base");
	if (index !== -1 && index + 1 < argv.length) {
		return argv[index + 1];
	}
	return "origin/main";
}

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
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const invalid = contractProblems(contract);
if (invalid.length > 0) {
	for (const problem of invalid) {
		console.error(problem);
	}
	process.exit(1);
}
const baseSql = {};
for (const path of baseFiles.filter((file) => file.endsWith(".sql"))) {
	const name = path.slice(path.lastIndexOf("/") + 1);
	baseSql[name] = execFileSync("git", ["show", `${base}:${path}`], {
		cwd: repoRoot,
		encoding: "utf8",
	});
}
const headSql = {};
for (const name of headFiles) {
	headSql[name] = readFileSync(join(migrationsDir, name), "utf8");
}
const squashed = JSON.parse(readFileSync(squashedPath, "utf8"));
const changed = changedMigrations(baseSql, headSql, squashed);
if (changed.length > 0) {
	for (const { file, change } of changed) {
		console.error(
			`${file}: ${change} after it reached ${base}; add a new migration instead`,
		);
	}
	process.exit(1);
}
const fresh = newMigrations(baseFiles, headFiles);
if (fresh.length === 0) {
	console.log("0 new migrations");
	process.exit(0);
}
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
