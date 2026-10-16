#!/usr/bin/env node
import { httpSmokeApi, runSmoke, smokeEnv } from "./lib/smoke.mjs";
/**
 * Post-deploy smoke test CLI. Reads HOOKFLARE_URL, CF_ACCESS_CLIENT_ID,
 * CF_ACCESS_CLIENT_SECRET, and SINK_URL from the env; --config selects the
 * gateway config (used for the worker name in logs only).
 */
import { readConfig } from "./lib/wrangler.mjs";

/**
 * Value of a `--flag value` argv option.
 * @param {string[]} argv
 * @param {string} flag
 * @param {string} fallback
 * @returns {string}
 */
function option(argv, flag, fallback) {
	const index = argv.indexOf(flag);
	return index !== -1 && index + 1 < argv.length ? argv[index + 1] : fallback;
}

const config = option(
	process.argv.slice(2),
	"--config",
	"apps/gateway/wrangler.jsonc",
);
let worker = config;
try {
	worker = readConfig(config).name;
} catch {
	// Env, not config, drives the smoke test; keep going with the raw path.
}
const env = smokeEnv();
if (env === null) {
	console.error(
		"smoke skipped: set HOOKFLARE_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, SINK_URL",
	);
	process.exit(1);
}
console.log(`smoke: worker ${worker} url ${env.url}`);
const result = await runSmoke(httpSmokeApi(env), console.log);
console.log(JSON.stringify(result));
