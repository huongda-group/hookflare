import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseJsonc } from "./jsonc.mjs";

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

export function readConfig(path) {
	const raw = readFileSync(path, "utf8");
	const parsed = parseJsonc(raw);
	const name = parsed.name;
	const dbs = parsed.d1_databases;
	const d1Name =
		Array.isArray(dbs) && dbs.length > 0 ? dbs[0].database_name : undefined;
	if (typeof name !== "string" || name.length === 0) {
		throw new Error(`wrangler: ${path} has no name`);
	}
	if (typeof d1Name !== "string" || d1Name.length === 0) {
		throw new Error(`wrangler: ${path} has no d1_databases entry`);
	}
	const vars = parsed.vars;
	const base = vars?.PUBLIC_BASE_URL;
	return {
		name,
		d1Name,
		publicBaseUrl: typeof base === "string" ? base : "",
	};
}
