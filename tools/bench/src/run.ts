/**
 * Open-loop load runner: `node src/run.ts <scenario.json>`.
 *
 * Reads HOOKFLARE_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, and
 * SINK_URL from the environment; provisions one destination and N hmac
 * sources through the same admin API the smoke test uses (reusing its
 * helpers through a relative import); fires the scenario's arrival schedule
 * without awaiting earlier requests; waits for the queue to drain; then
 * writes `results/<name>-<iso>.json` with `lost = accepted - sink.unique`.
 *
 * Node 24 runs this file directly through type stripping. Never imported
 * by the gateway.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pollUntil, runId, smokeEnv } from "../../../scripts/lib/smoke.mjs";
import { parseScenario, type Scenario } from "./scenario.ts";
import { arrivals } from "./schedule.ts";
import {
	BENCH_HEADER,
	makeBody,
	randomSecretBase64,
	signHmacHex,
} from "./sign.ts";
import { type SendResult, type Summary, summarize } from "./stats.ts";

export type SinkStats = {
	unique: number;
	received: number;
};

export type RunResult = {
	scenario: string;
	started_at: string;
	worker_version: string;
	steps: Summary[];
	drain_ms: number | null;
	sink: SinkStats;
	accepted: number;
	lost: number;
};

type Source = {
	id: string;
	ingress_url: string;
	secret: string;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True once the overview reports no backlog left to drain. */
export function isDrained(live: Record<string, number>): boolean {
	return (live.pending ?? 0) + (live.queued ?? 0) + (live.retrying ?? 0) === 0;
}

function accessHeaders(env: { clientId: string; clientSecret: string }) {
	return {
		"content-type": "application/json",
		"CF-Access-Client-Id": env.clientId,
		"CF-Access-Client-Secret": env.clientSecret,
	};
}

async function readJson(what: string, res: Response): Promise<unknown> {
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`bench: ${what} failed with ${res.status} ${text.slice(0, 200)}`,
		);
	}
	return res.json() as Promise<unknown>;
}

function sinkQuery(scenario: Scenario): string {
	const params = new URLSearchParams();
	if (scenario.sink.delay_ms !== undefined) {
		params.set("delay_ms", String(scenario.sink.delay_ms));
	}
	if (scenario.sink.fail_pct !== undefined) {
		params.set("fail_pct", String(scenario.sink.fail_pct));
	}
	const query = params.toString();
	return query === "" ? "" : `?${query}`;
}

async function provision(
	base: string,
	headers: Record<string, string>,
	scenario: Scenario,
	run: string,
	hookBase: string,
): Promise<Source[]> {
	const project = (await readJson(
		"create project",
		await fetch(`${base}/api/admin/v1/projects`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: `bench-${run}`, slug: `bench-${run}` }),
		}),
	)) as { id: string };
	const destination = (await readJson(
		"create destination",
		await fetch(`${base}/api/admin/v1/destinations`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				project_id: project.id,
				name: `bench-${run}`,
				url: `${hookBase}/r/${run}/hook${sinkQuery(scenario)}`,
			}),
		}),
	)) as { id: string };
	const sources: Source[] = [];
	for (let i = 0; i < scenario.sources; i++) {
		const secret = randomSecretBase64();
		const created = (await readJson(
			"create source",
			await fetch(`${base}/api/admin/v1/sources`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					project_id: project.id,
					destination_id: destination.id,
					name: `bench-${run}-${i}`,
					auth_type: "hmac",
					auth_config: {
						header: BENCH_HEADER,
						algorithm: "sha256",
						encoding: "hex",
					},
					secret,
				}),
			}),
		)) as { id: string; ingress_url: string };
		sources.push({ id: created.id, ingress_url: created.ingress_url, secret });
	}
	return sources;
}

async function sendOne(
	source: Source,
	body: string,
	webhookId: string,
): Promise<SendResult> {
	const started = performance.now();
	try {
		const res = await fetch(source.ingress_url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"webhook-id": webhookId,
				[BENCH_HEADER]: signHmacHex(source.secret, body),
			},
			body,
			signal: AbortSignal.timeout(30000),
		});
		await res.text().catch(() => "");
		return { status: res.status, ms: performance.now() - started };
	} catch {
		return { status: 0, ms: performance.now() - started };
	}
}

async function waitForDrain(
	base: string,
	headers: Record<string, string>,
	timeoutMs: number,
): Promise<number | null> {
	const started = Date.now();
	try {
		await pollUntil(
			async () => {
				const overview = (await readJson(
					"overview",
					await fetch(`${base}/api/admin/v1/overview`, { headers }),
				)) as { live: Record<string, number> };
				return isDrained(overview.live) ? true : null;
			},
			{ timeoutMs, intervalMs: 5000 },
		);
	} catch {
		return null;
	}
	return Date.now() - started;
}

async function sinkStats(sinkUrl: string, run: string): Promise<SinkStats> {
	const parsed = (await readJson(
		"sink stats",
		await fetch(`${sinkUrl}/r/${run}/stats`),
	)) as { unique: number; received: number };
	return { unique: parsed.unique, received: parsed.received };
}

function usage(): never {
	console.error("usage: node src/run.ts <scenario.json>");
	return process.exit(2);
}

export async function main(argv: string[]): Promise<void> {
	const file = argv[0];
	if (!file) usage();
	const scenario = parseScenario(JSON.parse(await readFile(file, "utf8")));
	const env = smokeEnv(process.env);
	if (!env) {
		console.error(
			"bench: missing one of HOOKFLARE_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, SINK_URL",
		);
		return process.exit(2);
	}
	const base = env.url.replace(/\/$/, "");
	const sinkUrl = env.sinkUrl.replace(/\/$/, "");
	const headers = accessHeaders(env);
	const run = runId();
	const startedAt = new Date().toISOString();

	const sources = await provision(base, headers, scenario, run, sinkUrl);
	console.error(`bench: run ${run} with ${sources.length} sources`);

	const body = makeBody(scenario.body_bytes, `bench-${run}-`);
	const pending: Promise<SendResult>[] = [];
	const stepSizes = scenario.steps.map((s) =>
		Math.round(s.rate_per_s * s.duration_s),
	);
	const t0 = Date.now();
	let n = 0;
	for (const at of arrivals(scenario.steps)) {
		const wait = t0 + at - Date.now();
		if (wait > 0) await sleep(wait);
		const source = sources[n % sources.length];
		pending.push(sendOne(source, body, `bench-${run}-${n}`));
		n++;
	}
	const results = await Promise.all(pending);

	const steps: Summary[] = [];
	let offset = 0;
	for (const size of stepSizes) {
		steps.push(summarize(results.slice(offset, offset + size)));
		offset += size;
	}

	const drainMs = await waitForDrain(
		base,
		headers,
		scenario.drain_timeout_s * 1000,
	);
	const sink = await sinkStats(sinkUrl, run);
	const accepted = results.filter((r) => r.status === 202).length;
	const result: RunResult = {
		scenario: scenario.name,
		started_at: startedAt,
		worker_version: process.env.HOOKFLARE_WORKER_VERSION ?? "unknown",
		steps,
		drain_ms: drainMs,
		sink,
		accepted,
		lost: accepted - sink.unique,
	};
	const here = process.argv[1].replace(/\\/g, "/");
	const dir = here.slice(0, here.lastIndexOf("/"));
	await mkdir(`${dir}/../results`, { recursive: true });
	const stamp = startedAt.replace(/[:.]/g, "-");
	await writeFile(
		`${dir}/../results/${scenario.name}-${stamp}.json`,
		JSON.stringify(result, null, "\t"),
		"utf8",
	);
	console.error(
		`bench: accepted=${accepted} unique=${sink.unique} lost=${result.lost} drain_ms=${drainMs}`,
	);
}

const invoked = (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("/run.ts");
if (invoked) {
	await main(process.argv.slice(2));
}
