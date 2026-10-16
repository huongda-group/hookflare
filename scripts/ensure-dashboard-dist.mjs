// wrangler fails when assets.directory is missing (spec §8). Dev and gateway
// tests do not need a real dashboard build, so write a placeholder.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"apps",
	"dashboard",
	"dist",
);
if (!existsSync(join(dist, "index.html"))) {
	mkdirSync(dist, { recursive: true });
	writeFileSync(
		join(dist, "index.html"),
		"<!doctype html><title>Hookflare</title><p>Dashboard not built. Run <code>pnpm build</code>.</p>\n",
	);
}
