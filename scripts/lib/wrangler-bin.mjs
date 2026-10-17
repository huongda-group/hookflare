/**
 * Resolve the repo-pinned wrangler binary for scripts that spawn it
 * directly: `node_modules/.bin/wrangler` under the repository root, or
 * bare `wrangler` from PATH when the local install is missing.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (two levels above `scripts/lib`). */
export const repoRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

/**
 * Path of the wrangler executable to spawn.
 * @param {string} [root] Repository root.
 * @param {(path: string) => boolean} [exists]
 * @returns {string}
 */
export function wranglerBin(root = repoRoot, exists = existsSync) {
	const local = join(
		root,
		"node_modules",
		".bin",
		process.platform === "win32" ? "wrangler.cmd" : "wrangler",
	);
	return exists(local) ? local : "wrangler";
}
