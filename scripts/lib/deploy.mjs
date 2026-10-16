/**
 * Deploy helpers: parse the wrangler JSON outputs captured before and after
 * a deploy, derive the ordered step list, and render the manual rollback
 * commands. This module never spawns anything; see `scripts/deploy.mjs`.
 */

/**
 * A recorded deploy: the restore point plus the rollback target.
 * `worker` doubles as the D1 database name (true for both gateway
 * configs: `hookflare` and `hookflare-staging`).
 * @typedef {{ at: string, config: string, worker: string, version: string, bookmark: string }} DeployRecord
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
	const full =
		versions.find(
			(version) =>
				typeof version === "object" &&
				version !== null &&
				/** @type {Record<string, unknown>} */ (version).percentage === 100,
		) ?? versions[0];
	if (typeof full !== "object" || full === null) {
		return null;
	}
	const record = /** @type {Record<string, unknown>} */ (full);
	for (const key of ["version_id", "version", "id"]) {
		if (typeof record[key] === "string" && record[key].length > 0) {
			return /** @type {string} */ (record[key]);
		}
	}
	return null;
}

/**
 * Parse the version ID of the newest deployment out of
 * `wrangler deployments list --json` output (an array, or an object with
 * a `deployments` array). Newest means the largest `created_on`.
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
 * Deploy options: the smoke env, or null when it is missing.
 * @typedef {{ smoke: { url: string, clientId: string, clientSecret: string, sinkUrl: string } | null }} DeployOptions
 */

/**
 * Ordered step names. The smoke step is skipped when the smoke env is
 * missing; the CLI prints the skip notice instead.
 * @param {DeployOptions} options
 * @returns {string[]}
 */
export function deployPlan({ smoke }) {
	const steps = ["record", "build", "migrate", "deploy"];
	if (smoke !== null) {
		steps.push("smoke");
	}
	steps.push("report");
	return steps;
}

/**
 * Manual rollback commands for a failed deploy. The CLI prints these and
 * exits; it never runs them.
 * @param {DeployRecord} record
 * @param {string} config
 * @returns {string[]}
 */
export function rollbackCommands(record, config) {
	return [
		`wrangler rollback ${record.version} --config ${config}`,
		`wrangler d1 time-travel restore ${record.worker} --bookmark=${record.bookmark} --config ${config}`,
	];
}
