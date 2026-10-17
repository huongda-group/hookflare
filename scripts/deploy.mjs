#!/usr/bin/env node
/**
 * Deploy CLI: record a restore point, build, migrate, deploy, smoke-test,
 * and write the deploy record to `.deploy/<at>.json`. On any failure it
 * prints the manual rollback commands for the steps that started (from
 * `rollbackCommands`) and exits 1; it never runs them. On success it
 * prints the same commands in the report so the restore point is at hand.
 *
 * The smoke step needs the gateway URL in the per-Worker variable from
 * `smokeUrlVar` (`HOOKFLARE_URL`, `HOOKFLARE_STAGING_URL`), plus
 * `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, and `SINK_URL`. A
 * missing smoke env fails the deploy before anything runs unless
 * `--skip-smoke` is passed.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	deployPlan,
	parseBookmark,
	parseCurrentVersion,
	rollbackCommands,
} from "./lib/deploy.mjs";
import {
	checkSmokeTarget,
	httpSmokeApi,
	runSmoke,
	smokeEnv,
	smokeUrlVar,
} from "./lib/smoke.mjs";
import { readConfig, runWrangler } from "./lib/wrangler.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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

/**
 * Run a local command (not wrangler) and resolve with its exit code.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<number>}
 */
function runLocal(cmd, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd: repoRoot, stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 1));
	});
}

/**
 * Filename-safe UTC timestamp for the deploy record.
 * @returns {string}
 */
function recordAt() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

const argv = process.argv.slice(2);
const config = option(argv, "--config", "apps/gateway/wrangler.jsonc");
const skipSmoke = argv.includes("--skip-smoke");
const { name: worker, d1Name, publicBaseUrl } = readConfig(config);
const urlVar = smokeUrlVar(worker);
const smoke = smokeEnv(process.env, { urlVar });
let plan;
try {
	plan = deployPlan({ smoke, skipSmoke });
	if (smoke !== null && !skipSmoke) {
		checkSmokeTarget(smoke.url, { worker, publicBaseUrl });
	}
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err));
	console.error(
		`deploy: smoke needs ${urlVar}, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, SINK_URL`,
	);
	process.exit(1);
}
/** @type {import("./lib/deploy.mjs").DeployRecord & { previousVersion: string, newVersion: string, smoke: string }} */
const record = {
	at: recordAt(),
	config,
	worker,
	d1Name,
	previousVersion: "unknown",
	newVersion: "unknown",
	bookmark: "unknown",
	smoke: skipSmoke ? "skipped" : "pending",
};
/** Steps that began, so `fail` lists only what they may have changed. */
const started = [];

if (skipSmoke) {
	console.warn(
		[
			"",
			"!!! ------------------------------------------------------------ !!!",
			"!!! deploy: --skip-smoke: this deploy will NOT be smoke-tested.  !!!",
			`!!! Run \`node scripts/smoke.mjs --config ${config}\` yourself.`,
			"!!! ------------------------------------------------------------ !!!",
			"",
		].join("\n"),
	);
}

/**
 * Print the manual rollback commands and exit 1. Never runs them.
 * @param {string} step
 * @param {string} detail
 * @returns {never}
 */
function fail(step, detail) {
	console.error(`deploy: step "${step}" failed: ${detail}`);
	const commands =
		record.bookmark === "unknown" || record.previousVersion === "unknown"
			? []
			: rollbackCommands(record, config, started);
	if (commands.length === 0) {
		console.error("rollback: nothing changed remotely; nothing to roll back");
	}
	for (const command of commands) {
		console.error(`rollback: ${command}`);
	}
	process.exit(1);
}

for (const step of plan) {
	console.log(`deploy: step "${step}" started`);
	started.push(step);
	if (step === "record") {
		const info = await runWrangler(
			["d1", "time-travel", "info", d1Name, "--json"],
			{ config },
		);
		if (info.code !== 0) {
			fail(step, info.stderr.trim() || "time-travel info failed");
		}
		const versions = await runWrangler(["deployments", "list", "--json"], {
			config,
		});
		if (versions.code !== 0) {
			fail(step, versions.stderr.trim() || "deployments list failed");
		}
		try {
			record.bookmark = parseBookmark(JSON.parse(info.stdout));
			record.previousVersion = parseCurrentVersion(JSON.parse(versions.stdout));
		} catch (err) {
			fail(step, err instanceof Error ? err.message : String(err));
		}
		console.log(
			`deploy: restore point ${record.bookmark} at ${record.previousVersion}`,
		);
	} else if (step === "build") {
		if ((await runLocal("pnpm", ["build"])) !== 0) {
			fail(step, "pnpm build failed");
		}
	} else if (step === "migrate") {
		const migrated = await runWrangler(
			["d1", "migrations", "apply", "DB", "--remote"],
			{ config, stream: true },
		);
		if (migrated.code !== 0) {
			fail(step, migrated.stderr.trim() || "migrations apply failed");
		}
	} else if (step === "deploy") {
		const deployed = await runWrangler(["deploy"], { config, stream: true });
		if (deployed.code !== 0) {
			fail(step, deployed.stderr.trim() || "wrangler deploy failed");
		}
		const versions = await runWrangler(["deployments", "list", "--json"], {
			config,
		});
		if (versions.code !== 0) {
			fail(step, versions.stderr.trim() || "deployments list failed");
		}
		try {
			record.newVersion = parseCurrentVersion(JSON.parse(versions.stdout));
		} catch (err) {
			fail(step, err instanceof Error ? err.message : String(err));
		}
		console.log(
			`deploy: version ${record.newVersion} (was ${record.previousVersion})`,
		);
	} else if (step === "smoke") {
		try {
			const result = await runSmoke(httpSmokeApi(smoke), console.log);
			record.smoke = "passed";
			console.log(`deploy: smoke ok ${JSON.stringify(result)}`);
		} catch (err) {
			fail(step, err instanceof Error ? err.message : String(err));
		}
	} else if (step === "report") {
		const rollback = rollbackCommands(record, config);
		const dir = join(repoRoot, ".deploy");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${record.at}.json`),
			`${JSON.stringify({ ...record, rollback }, null, 2)}\n`,
		);
		console.log(`deploy: wrote .deploy/${record.at}.json`);
		console.log(
			`deploy: ${record.worker} ${record.previousVersion} -> ${record.newVersion}, smoke ${record.smoke}`,
		);
		console.log(
			"deploy: to undo this release (decide first, see rollback.md):",
		);
		for (const command of rollback) {
			console.log(`rollback: ${command}`);
		}
	}
}
