/**
 * Deploy helpers: parse the wrangler JSON outputs captured before and after
 * a deploy, derive the ordered step list, and render the manual rollback
 * commands. This module never spawns anything; see `scripts/deploy.mjs`.
 */

/**
 * A recorded deploy: the restore point plus the rollback target.
 * `d1Name` is the D1 database name for the time-travel restore; `worker`
 * is kept as the fallback for records written before `d1Name` existed
 * (both gateway configs name them identically today: `hookflare` and
 * `hookflare-staging`). `previousVersion` is the Worker version live before
 * the deploy (the rollback target) and `newVersion` the one it deployed;
 * older records only have `version`, which was the previous version.
 * @typedef {{ at: string, config: string, worker: string, d1Name?: string, previousVersion?: string, newVersion?: string, version?: string, bookmark: string, smoke?: string, rollback?: string[] }} DeployRecord
 */

/**
 * Pull a non-empty bookmark string out of a candidate object.
 * @param {unknown} candidate
 * @returns {string | null}
 */
function bookmarkOf(candidate) {
	if (typeof candidate !== "object" || candidate === null) {
		return null;
	}
	const bookmark = /** @type {Record<string, unknown>} */ (candidate).bookmark;
	return typeof bookmark === "string" && bookmark.length > 0 ? bookmark : null;
}

/**
 * Timestamp used to prefer the newest entry of a time-travel list.
 * @param {unknown} candidate
 * @returns {string}
 */
function entryTime(candidate) {
	if (typeof candidate !== "object" || candidate === null) {
		return "";
	}
	const entry = /** @type {Record<string, unknown>} */ (candidate);
	for (const key of ["created_on", "created_at", "timestamp"]) {
		if (typeof entry[key] === "string") {
			return /** @type {string} */ (entry[key]);
		}
	}
	return "";
}

/**
 * Parse the bookmark out of `wrangler d1 time-travel info --json` output.
 * Current wrangler prints a single `{bookmark}` object; arrays are
 * accepted too and resolve to the newest entry.
 * @param {unknown} json
 * @returns {string}
 */
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

/**
 * Version ID of one entry of `wrangler deployments list --json` output.
 * @param {unknown} entry
 * @returns {string | null}
 */
function entryVersion(entry) {
	if (typeof entry !== "object" || entry === null) {
		return null;
	}
	const versions = /** @type {Record<string, unknown>} */ (entry).versions;
	if (!Array.isArray(versions) || versions.length === 0) {
		return null;
	}
	const entryVersions = /** @type {Record<string, unknown>[]} */ (
		versions.filter(
			(version) => typeof version === "object" && version !== null,
		)
	);
	// A single version carries all traffic even when wrangler omits the
	// percentage. A gradual split has no rollback target the script can name,
	// so it fails instead of guessing.
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

/**
 * Version ID field of one `versions[]` entry.
 * @param {Record<string, unknown>} version
 * @returns {string | null}
 */
function versionId(version) {
	for (const key of ["version_id", "version", "id"]) {
		if (typeof version[key] === "string" && version[key].length > 0) {
			return /** @type {string} */ (version[key]);
		}
	}
	return null;
}

/**
 * Parse the version ID of the newest deployment out of
 * `wrangler deployments list --json` output (an array, or an object with
 * a `deployments` array). Newest means the largest `created_on`. Throws
 * when the newest deployment is a gradual split (no version at 100%).
 * @param {unknown} json
 * @returns {string}
 */
export function parseCurrentVersion(json) {
	const list = Array.isArray(json)
		? json
		: typeof json === "object" &&
				json !== null &&
				Array.isArray(/** @type {Record<string, unknown>} */ (json).deployments)
			? /** @type {unknown[]} */ (
					/** @type {Record<string, unknown>} */ (json).deployments
				)
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

/**
 * Deploy options: the smoke env (null when it is missing) and whether
 * `--skip-smoke` was passed.
 * @typedef {{ smoke: { url: string, clientId: string, clientSecret: string, sinkUrl: string } | null, skipSmoke: boolean }} DeployOptions
 */

/**
 * Ordered step names. A missing smoke env is an error unless
 * `--skip-smoke` was passed; the CLI prints a loud notice when skipping.
 * @param {DeployOptions} options
 * @returns {string[]}
 */
export function deployPlan({ smoke, skipSmoke }) {
	if (smoke === null && !skipSmoke) {
		throw new Error(
			"deploy: smoke env missing; set it (see docs/runbook/deploy.md) or pass --skip-smoke",
		);
	}
	const steps = ["record", "build", "migrate", "deploy"];
	if (!skipSmoke) {
		steps.push("smoke");
	}
	steps.push("report");
	return steps;
}

/** Every step that changes remote state, for a full rollback listing. */
const ALL_STEPS = ["record", "build", "migrate", "deploy", "smoke", "report"];

/**
 * Manual rollback commands. The CLI prints these (on failure, and in the
 * report on success) and never runs them. `started` lists the steps that
 * began: the Worker rollback is listed only once the deploy step started,
 * and the D1 restore only once the migrate step started. The Worker
 * rollback always targets the version that was live before the deploy.
 * @param {DeployRecord} record
 * @param {string} config
 * @param {string[]} [started]
 * @returns {string[]}
 */
export function rollbackCommands(record, config, started = ALL_STEPS) {
	const d1Name = record.d1Name ?? record.worker;
	const previous = record.previousVersion ?? record.version;
	const commands = [];
	if (started.includes("deploy") && previous !== undefined) {
		commands.push(`wrangler rollback ${previous} --config ${config}`);
	}
	if (started.includes("migrate")) {
		commands.push(
			`wrangler d1 time-travel restore ${d1Name} --bookmark=${record.bookmark} --config ${config}`,
		);
	}
	return commands;
}
