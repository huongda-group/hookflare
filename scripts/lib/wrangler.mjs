/**
 * Small wrapper around wrangler and wrangler-config reads for the ops
 * scripts. Spawning goes through `pnpm exec` so the repo-pinned wrangler
 * is used; nothing here changes remote state by itself.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseJsonc } from "./jsonc.mjs";

/**
 * Config needed to run wrangler against one Worker.
 * @typedef {{ config: string }} WranglerOptions
 */

/**
 * Result of a wrangler invocation.
 * @typedef {{ code: number, stdout: string, stderr: string }} WranglerResult
 */

/**
 * Run `pnpm exec wrangler ...args --config <config>` and resolve with the
 * exit code plus captured output. With `stream`, output is also echoed to
 * this process's stdout/stderr as it arrives, so long steps are not silent.
 * @param {string[]} args
 * @param {WranglerOptions & { stream?: boolean }} options
 * @returns {Promise<WranglerResult>}
 */
export function runWrangler(args, { config, stream = false }) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"pnpm",
			["exec", "wrangler", ...args, "--config", config],
			{
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (stream) {
				process.stdout.write(chunk);
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (stream) {
				process.stderr.write(chunk);
			}
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

/**
 * Names read from a gateway wrangler config.
 * @typedef {{ name: string, d1Name: string, publicBaseUrl: string }} WorkerConfig
 */

/**
 * Read a wrangler config and return the Worker name, the first D1
 * database name, and `vars.PUBLIC_BASE_URL` ("" when unset). Throws when
 * the name or D1 database is missing.
 * @param {string} path
 * @returns {WorkerConfig}
 */
export function readConfig(path) {
	const raw = readFileSync(path, "utf8");
	const parsed = /** @type {Record<string, unknown>} */ (parseJsonc(raw));
	const name = parsed.name;
	const dbs = parsed.d1_databases;
	const d1Name =
		Array.isArray(dbs) && dbs.length > 0
			? /** @type {Record<string, unknown>} */ (dbs[0]).database_name
			: undefined;
	if (typeof name !== "string" || name.length === 0) {
		throw new Error(`wrangler: ${path} has no name`);
	}
	if (typeof d1Name !== "string" || d1Name.length === 0) {
		throw new Error(`wrangler: ${path} has no d1_databases entry`);
	}
	const vars = /** @type {Record<string, unknown> | undefined} */ (parsed.vars);
	const base = vars?.PUBLIC_BASE_URL;
	return {
		name,
		d1Name,
		publicBaseUrl: typeof base === "string" ? base : "",
	};
}
