#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	deployPlan,
	migrationsApplied,
	NO_PREVIOUS_VERSION,
	parseBookmark,
	parseCurrentVersion,
	rollbackCommands,
	workerMissing,
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

function option(argv, flag, fallback) {
	const index = argv.indexOf(flag);
	return index !== -1 && index + 1 < argv.length ? argv[index + 1] : fallback;
}

function runLocal(cmd, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd: repoRoot, stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 1));
	});
}

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
	console.error(`deploy: smoke needs ${urlVar}, HOOKFLARE_API_TOKEN, SINK_URL`);
	process.exit(1);
}
const record = {
	at: recordAt(),
	config,
	worker,
	d1Name,
	previousVersion: "unknown",
	newVersion: "unknown",
	bookmark: "unknown",
	bookmarkAt: "unknown",
	smoke: skipSmoke ? "skipped" : "pending",
};
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
		const firstDeploy = workerMissing(versions);
		if (versions.code !== 0 && !firstDeploy) {
			fail(step, versions.stderr.trim() || "deployments list failed");
		}
		try {
			record.bookmark = parseBookmark(JSON.parse(info.stdout));
			record.bookmarkAt = new Date().toISOString();
			record.previousVersion = firstDeploy
				? NO_PREVIOUS_VERSION
				: parseCurrentVersion(JSON.parse(versions.stdout));
		} catch (err) {
			fail(step, err instanceof Error ? err.message : String(err));
		}
		console.log(
			firstDeploy
				? `deploy: restore point ${record.bookmark}; first deploy, no live Worker version yet`
				: `deploy: restore point ${record.bookmark} at ${record.previousVersion}`,
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
		record.migrationsApplied = migrationsApplied(migrated);
		if (migrated.code !== 0) {
			fail(step, migrated.stderr.trim() || "migrations apply failed");
		}
		console.log(
			record.migrationsApplied
				? "deploy: migrations applied; a D1 restore would undo them"
				: "deploy: no migrations applied; no D1 restore needed",
		);
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
			"deploy: to undo this release (decide first, see docs/runbook.md#rollback):",
		);
		for (const command of rollback) {
			console.log(`rollback: ${command}`);
		}
	}
}
