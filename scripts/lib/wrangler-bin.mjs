import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

export function wranglerBin(root = repoRoot, exists = existsSync) {
	const local = join(
		root,
		"node_modules",
		".bin",
		process.platform === "win32" ? "wrangler.cmd" : "wrangler",
	);
	return exists(local) ? local : "wrangler";
}
