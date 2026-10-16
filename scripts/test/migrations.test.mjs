import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	checkMigrations,
	findDestructive,
	newMigrations,
} from "../lib/migrations.mjs";

const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"apps",
	"gateway",
	"migrations",
);

/**
 * List the migration files already on the base branch, or null when the
 * base ref is unavailable (fork or shallow checkout).
 * @param {string} base
 * @returns {Set<string> | null}
 */
function baseFiles(base) {
	try {
		const out = execFileSync(
			"git",
			["ls-tree", "--name-only", base, "apps/gateway/migrations/"],
			{ encoding: "utf8" },
		);
		return new Set(
			out
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.endsWith(".sql"))
				.map((line) => basename(line)),
		);
	} catch {
		return null;
	}
}

describe("findDestructive", () => {
	it("flags ADD COLUMN NOT NULL without a DEFAULT", () => {
		assert.deepEqual(findDestructive("ALTER TABLE a ADD b text NOT NULL;"), [
			"ADD COLUMN NOT NULL without DEFAULT",
		]);
	});

	it("allows ADD COLUMN NOT NULL with a DEFAULT", () => {
		assert.deepEqual(
			findDestructive("ALTER TABLE a ADD b text DEFAULT 'x' NOT NULL;"),
			[],
		);
	});

	it("flags both DROP TABLE and RENAME in a Drizzle table rebuild", () => {
		const reasons = findDestructive(
			"CREATE TABLE __new_x (id text); DROP TABLE x; ALTER TABLE __new_x RENAME TO x;",
		);
		assert.ok(reasons.includes("DROP TABLE"), `got ${reasons}`);
		assert.ok(reasons.includes("RENAME"), `got ${reasons}`);
	});

	it("ignores -- comment lines", () => {
		assert.deepEqual(findDestructive("-- DROP TABLE x\nSELECT 1;"), []);
	});

	it("flags DROP COLUMN case-insensitively", () => {
		assert.deepEqual(findDestructive("alter table a drop column b;"), [
			"DROP COLUMN",
		]);
	});
});

describe("newMigrations", () => {
	it("returns .sql names in head that are not in base", () => {
		assert.deepEqual(
			newMigrations(["0001.sql"], ["0001.sql", "0002.sql", "meta"]),
			["0002.sql"],
		);
	});
});

describe("checkMigrations", () => {
	const destructive = "ALTER TABLE a ADD b text NOT NULL;";

	it("passes a destructive file listed in the contract", () => {
		const result = checkMigrations({
			files: [{ name: "0002.sql", sql: destructive }],
			contract: [{ file: "0002.sql", release: "v1", reason: "backfill" }],
		});
		assert.equal(result.ok, true);
	});

	it("fails a destructive file missing from the contract", () => {
		const result = checkMigrations({
			files: [{ name: "0002.sql", sql: destructive }],
			contract: [],
		});
		assert.equal(result.ok, false);
		assert.deepEqual(result.problems, [
			{ file: "0002.sql", reasons: ["ADD COLUMN NOT NULL without DEFAULT"] },
		]);
	});

	it("repository guard: only files already on main may be destructive", () => {
		const onBase = baseFiles("origin/main") ?? baseFiles("main");
		assert.ok(onBase !== null, "expected a base ref for the guard test");
		const files = readdirSync(migrationsDir)
			.filter((name) => name.endsWith(".sql"))
			.map((name) => ({
				name,
				sql: readFileSync(join(migrationsDir, name), "utf8"),
			}));
		const result = checkMigrations({ files, contract: [] });
		for (const problem of result.problems) {
			assert.ok(
				onBase.has(basename(problem.file)),
				`destructive migration ${problem.file} is not on main`,
			);
		}
	});
});
