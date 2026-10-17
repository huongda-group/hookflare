/**
 * Migration safety checks: detect destructive SQL in new Drizzle migrations
 * unless the migration is listed in the contract file.
 */

/**
 * Strip `--` comments from SQL, tracking string literals so `--` inside
 * quotes is preserved.
 * @param {string} sql
 * @returns {string}
 */
function stripLineComments(sql) {
	let out = "";
	let quote = null;
	let i = 0;
	while (i < sql.length) {
		const ch = sql[i];
		if (quote !== null) {
			out += ch;
			if (ch === quote) {
				quote = null;
			}
			i++;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			out += ch;
			i++;
			continue;
		}
		if (ch === "-" && sql[i + 1] === "-") {
			while (i < sql.length && sql[i] !== "\n") {
				i++;
			}
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/**
 * Find the destructive operations in a migration's SQL. Returns reasons from
 * `"DROP TABLE"`, `"DROP COLUMN"`, `"RENAME"`, and
 * `"ADD COLUMN NOT NULL without DEFAULT"`. Matching is case-insensitive and
 * `--` comment lines are ignored.
 * @param {string} sql
 * @returns {string[]}
 */
export function findDestructive(sql) {
	const clean = stripLineComments(sql);
	/** @type {string[]} */
	const reasons = [];
	if (/\bDROP\s+TABLE\b/i.test(clean)) {
		reasons.push("DROP TABLE");
	}
	if (/\bDROP\s+COLUMN\b/i.test(clean)) {
		reasons.push("DROP COLUMN");
	}
	if (/\bRENAME\b/i.test(clean)) {
		reasons.push("RENAME");
	}
	const addsNotNullWithoutDefault = clean.split(";").some((statement) => {
		if (!/\bADD\b/i.test(statement)) {
			return false;
		}
		if (!/\bNOT\s+NULL\b/i.test(statement)) {
			return false;
		}
		return !/\bDEFAULT\b/i.test(statement);
	});
	if (addsNotNullWithoutDefault) {
		reasons.push("ADD COLUMN NOT NULL without DEFAULT");
	}
	return reasons;
}

/**
 * Basename of a migration path.
 * @param {string} file
 * @returns {string}
 */
function migrationName(file) {
	const slash = file.lastIndexOf("/");
	return slash === -1 ? file : file.slice(slash + 1);
}

/**
 * Return the `.sql` names in head that are not in base.
 * @param {string[]} baseFiles
 * @param {string[]} headFiles
 * @returns {string[]}
 */
export function newMigrations(baseFiles, headFiles) {
	const base = new Set(
		baseFiles
			.filter((file) => file.endsWith(".sql"))
			.map((file) => migrationName(file)),
	);
	return headFiles.filter(
		(file) => file.endsWith(".sql") && !base.has(migrationName(file)),
	);
}

/**
 * Migrations on the base ref that the head changed: a modified or removed
 * migration rewrites history that D1 has already applied (and records by
 * name only), so it never takes effect remotely. Line endings are
 * normalized before comparing.
 * @param {Record<string, string>} base `.sql` name → content at the base ref.
 * @param {Record<string, string>} head `.sql` name → content in the tree.
 * @returns {{ file: string, change: "modified" | "removed" }[]}
 */
export function changedMigrations(base, head) {
	/** @param {string} sql */
	const normalize = (sql) => sql.replace(/\r\n/g, "\n");
	/** @type {{ file: string, change: "modified" | "removed" }[]} */
	const changed = [];
	for (const [file, sql] of Object.entries(base)) {
		if (!(file in head)) {
			changed.push({ file, change: "removed" });
		} else if (normalize(head[file]) !== normalize(sql)) {
			changed.push({ file, change: "modified" });
		}
	}
	return changed;
}

/**
 * Problems in a parsed `contract.json`: it must be an array of
 * `{ file, release, reason }` objects with non-empty strings.
 * @param {unknown} contract
 * @returns {string[]}
 */
export function contractProblems(contract) {
	if (!Array.isArray(contract)) {
		return ["contract.json must be an array"];
	}
	/** @type {string[]} */
	const problems = [];
	contract.forEach((entry, index) => {
		if (typeof entry !== "object" || entry === null) {
			problems.push(
				`contract.json[${index}]: must be an object with file, release, and reason`,
			);
			return;
		}
		const fields = /** @type {Record<string, unknown>} */ (entry);
		const label =
			typeof fields.file === "string"
				? `contract.json[${index}] (${fields.file})`
				: `contract.json[${index}]`;
		for (const key of ["file", "release", "reason"]) {
			const value = fields[key];
			if (typeof value !== "string" || value.trim().length === 0) {
				problems.push(`${label}: missing ${key}`);
			}
		}
	});
	return problems;
}

/**
 * A contract entry that excuses a destructive migration.
 * @typedef {{ file: string, release: string, reason: string }} ContractEntry
 */

/**
 * A migration file under review.
 * @typedef {{ name: string, sql: string }} MigrationFile
 */

/**
 * Check migration files against the contract. Destructive files listed in
 * the contract pass; destructive files missing from it are problems.
 * @param {{ files: MigrationFile[], contract: ContractEntry[] }} input
 * @returns {{ ok: boolean, problems: { file: string, reasons: string[] }[] }}
 */
export function checkMigrations({ files, contract }) {
	const excused = new Set(contract.map((entry) => migrationName(entry.file)));
	/** @type {{ file: string, reasons: string[] }[]} */
	const problems = [];
	for (const file of files) {
		const reasons = findDestructive(file.sql);
		if (reasons.length > 0 && !excused.has(migrationName(file.name))) {
			problems.push({ file: file.name, reasons });
		}
	}
	return { ok: problems.length === 0, problems };
}
