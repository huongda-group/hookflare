#!/usr/bin/env node
/**
 * Deploy CLI: record a restore point, build, migrate, deploy, smoke-test,
 * and write the deploy record to `.deploy/<at>.json`. On any failure it
 * prints the manual rollback commands (from `rollbackCommands`) and exits
 * 1; it never runs them.
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
import { httpSmokeApi, runSmoke, smokeEnv } from "./lib/smoke.mjs";
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

const config = option(
	process.argv.slice(2),
	"--config",
	"apps/gateway/wrangler.jsonc",
);
const { name: worker, d1Name } = readConfig(config);
const smoke = smokeEnv();
const plan = deployPlan({ smoke });
/** @type {{ at: string, config: string, worker: string, d1Name: string, version: string, bookmark: string }} */
const record = {
	at: recordAt(),
	config,
	worker,
	d1Name,
	version: "unknown",
	bookmark: "unknown",
};

if (smoke === null) {
	console.log(
		"smoke skipped: set HOOKFLARE_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, SINK_URL",
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
	if (record.bookmark !== "unknown" && record.version !== "unknown") {
		for (const command of rollbackCommands(record, config)) {
			console.error(`rollback: ${command}`);
		}
	} else {
		console.error(
			"rollback: no restore point recorded; nothing to roll back to",
		);
	}
	process.exit(1);
}

for (const step of plan) {
	console.log(`deploy: step "${step}"`);
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
			record.version = parseCurrentVersion(JSON.parse(versions.stdout));
		} catch (err) {
			fail(step, err instanceof Error ? err.message : String(err));
		}
		console.log(
			`deploy: restore point ${record.bookmark} at ${record.version}`,
		);
	} else if (step === "build") {
		if ((await runLocal("pnpm", ["build"])) !== 0) {
			fail(step, "pnpm build failed");
		}
	} else if (step === "migrate") {
		const migrated = await runWrangler(
			["d1", "migrations", "apply", "DB", "--remote"],
			{ config },
		);
		if (migrated.code !== 0) {
			fail(step, migrated.stderr.trim() || "migrations apply failed");
		}
	} else if (step === "deploy") {
		const deployed = await runWrangler(["deploy"], { config });
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
			record.version = parseCurrentVersion(JSON.parse(versions.stdout));
		} catch (err) {
			fail(step, err instanceof Error ? err.message : String(err));
		}
		console.log(`deploy: version ${record.version}`);
	} else if (step === "smoke") {
		try {
			const result = await runSmoke(httpSmokeApi(smoke), console.log);
			console.log(`deploy: smoke ok ${JSON.stringify(result)}`);
		} catch (err) {
			fail(step, err instanceof Error ? err.message : String(err));
		}
	} else if (step === "report") {
		const dir = join(repoRoot, ".deploy");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${record.at}.json`),
			`${JSON.stringify(record, null, 2)}\n`,
		);
		console.log(`deploy: wrote .deploy/${record.at}.json`);
	}
}
