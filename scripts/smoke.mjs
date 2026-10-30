#!/usr/bin/env node
/**
 * Post-deploy smoke test CLI. --config selects the gateway config; the
 * gateway URL comes from that Worker's variable (`smokeUrlVar`:
 * `HOOKFLARE_URL` for `hookflare`, `HOOKFLARE_STAGING_URL` for
 * `hookflare-staging`), and it must match the config (`checkSmokeTarget`).
 * HOOKFLARE_API_TOKEN and SINK_URL come from the env as well.
 */
import {
	checkSmokeTarget,
	httpSmokeApi,
	runSmoke,
	smokeEnv,
	smokeUrlVar,
} from "./lib/smoke.mjs";
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
const { name: worker, publicBaseUrl } = readConfig(config);
const urlVar = smokeUrlVar(worker);
const env = smokeEnv(process.env, { urlVar });
if (env === null) {
	console.error(`smoke: set ${urlVar}, HOOKFLARE_API_TOKEN, SINK_URL`);
	process.exit(1);
}
try {
	checkSmokeTarget(env.url, { worker, publicBaseUrl });
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
}
console.log(`smoke: worker ${worker} url ${env.url}`);
const result = await runSmoke(httpSmokeApi(env), console.log);
console.log(JSON.stringify(result));
