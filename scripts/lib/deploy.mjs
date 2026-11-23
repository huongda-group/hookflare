function bookmarkOf(candidate) {
	if (typeof candidate !== "object" || candidate === null) {
		return null;
	}
	const bookmark = candidate.bookmark;
	return typeof bookmark === "string" && bookmark.length > 0 ? bookmark : null;
}

function entryTime(candidate) {
	if (typeof candidate !== "object" || candidate === null) {
		return "";
	}
	const entry = candidate;
	for (const key of ["created_on", "created_at", "timestamp"]) {
		if (typeof entry[key] === "string") {
			return entry[key];
		}
	}
	return "";
}

export function parseBookmark(json) {
	const direct = bookmarkOf(json);
	if (direct !== null) {
		return direct;
	}
	if (Array.isArray(json)) {
		const entries = [...json].sort((a, b) =>
			entryTime(b).localeCompare(entryTime(a)),
		);
		for (const entry of entries) {
			const bookmark = bookmarkOf(entry);
			if (bookmark !== null) {
				return bookmark;
			}
		}
	}
	throw new Error("deploy: no bookmark in time-travel info output");
}

function entryVersion(entry) {
	if (typeof entry !== "object" || entry === null) {
		return null;
	}
	const versions = entry.versions;
	if (!Array.isArray(versions) || versions.length === 0) {
		return null;
	}
	const entryVersions = versions.filter(
		(version) => typeof version === "object" && version !== null,
	);
	const full =
		entryVersions.length === 1
			? entryVersions[0]
			: entryVersions.find((version) => version.percentage === 100);
	if (full === undefined) {
		const split = entryVersions
			.map((version) => `${versionId(version)} ${version.percentage}%`)
			.join(", ");
		throw new Error(
			`deploy: the newest deployment splits traffic (${split}); finish or roll back the gradual deployment first`,
		);
	}
	return versionId(full);
}

function versionId(version) {
	for (const key of ["version_id", "version", "id"]) {
		if (typeof version[key] === "string" && version[key].length > 0) {
			return version[key];
		}
	}
	return null;
}

export function parseCurrentVersion(json) {
	const list = Array.isArray(json)
		? json
		: typeof json === "object" &&
				json !== null &&
				Array.isArray(json.deployments)
			? json.deployments
			: null;
	if (list === null) {
		throw new Error("deploy: no deployments in deployments list output");
	}
	const entries = [...list].sort((a, b) =>
		entryTime(a).localeCompare(entryTime(b)),
	);
	for (let i = entries.length - 1; i >= 0; i--) {
		const version = entryVersion(entries[i]);
		if (version !== null) {
			return version;
		}
	}
	throw new Error("deploy: no version in deployments list output");
}

export const NO_PREVIOUS_VERSION = "none";

export function workerMissing({ code, stdout, stderr }) {
	return code !== 0 && /\[code: 10007\]/.test(`${stdout}\n${stderr}`);
}

export function deployPlan({ smoke, skipSmoke }) {
	if (smoke === null && !skipSmoke) {
		throw new Error(
			"deploy: smoke env missing; set it (see docs/runbook.md#deploy-and-smoke) or pass --skip-smoke",
		);
	}
	const steps = ["build", "record", "migrate", "deploy"];
	if (!skipSmoke) {
		steps.push("smoke");
	}
	steps.push("report");
	return steps;
}

export function migrationsApplied({ code, stdout, stderr }) {
	if (code !== 0) {
		return true;
	}
	return !/no migrations to apply/i.test(`${stdout}\n${stderr}`);
}

const ALL_STEPS = ["build", "record", "migrate", "deploy", "smoke", "report"];

export function rollbackCommands(record, config, started = ALL_STEPS) {
	const d1Name = record.d1Name ?? record.worker;
	const previous = record.previousVersion ?? record.version;
	const commands = [];
	if (started.includes("deploy") && previous === NO_PREVIOUS_VERSION) {
		commands.push("# first deploy: no previous Worker version to roll back to");
	} else if (started.includes("deploy") && previous !== undefined) {
		commands.push(`wrangler rollback ${previous} --config ${config}`);
	}
	if (started.includes("migrate") && record.migrationsApplied !== false) {
		const since = record.bookmarkAt ?? "the restore point";
		commands.push(
			`# DESTRUCTIVE: discards every D1 write (including accepted webhooks) since ${since}; only if the new migrations must be undone`,
			`wrangler d1 time-travel restore ${d1Name} --bookmark=${record.bookmark} --config ${config}`,
		);
	}
	return commands;
}
