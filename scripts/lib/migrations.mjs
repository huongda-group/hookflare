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

export function findDestructive(sql) {
	const clean = stripLineComments(sql);
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

function migrationName(file) {
	const slash = file.lastIndexOf("/");
	return slash === -1 ? file : file.slice(slash + 1);
}

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

export function changedMigrations(base, head, squashed = []) {
	const normalize = (sql) => sql.replace(/\r\n/g, "\n");
	const changed = [];
	for (const [file, sql] of Object.entries(base)) {
		if (!(file in head)) {
			if (squashed.includes(file)) {
				continue;
			}
			changed.push({ file, change: "removed" });
		} else if (normalize(head[file]) !== normalize(sql)) {
			changed.push({ file, change: "modified" });
		}
	}
	return changed;
}

export function contractProblems(contract) {
	if (!Array.isArray(contract)) {
		return ["contract.json must be an array"];
	}
	const problems = [];
	contract.forEach((entry, index) => {
		if (typeof entry !== "object" || entry === null) {
			problems.push(
				`contract.json[${index}]: must be an object with file, release, and reason`,
			);
			return;
		}
		const fields = entry;
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

export function checkMigrations({ files, contract }) {
	const excused = new Set(contract.map((entry) => migrationName(entry.file)));
	const problems = [];
	for (const file of files) {
		const reasons = findDestructive(file.sql);
		if (reasons.length > 0 && !excused.has(migrationName(file.name))) {
			problems.push({ file: file.name, reasons });
		}
	}
	return { ok: problems.length === 0, problems };
}
