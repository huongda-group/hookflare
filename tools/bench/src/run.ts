/**
 * Open-loop load runner: `node src/run.ts <scenario.json> [--yes | --estimate]`.
 *
 * Without `--yes` (or with `--estimate`) it only prints the offline cost
 * estimate for the scenario and exits; nothing is sent. With `--yes` it
 * reads HOOKFLARE_URL, HOOKFLARE_API_TOKEN, and
 * SINK_URL from the environment, refuses a production URL, provisions one
 * project, one destination, and N hmac sources through the admin API the
 * smoke test uses, fires the arrival schedule without awaiting earlier
 * requests (PATCHing the destination URL at step boundaries when a step
 * has its own sink spec), waits for the project's backlog to drain, then
 * writes `results/<name>-<iso>.json`.
 *
 * Latency is measured from each request's scheduled send time, so a
 * stalled sender shows up as latency instead of hiding it (coordinated
 * omission); per step the achieved send rate and lateness are reported.
 *
 * Node 24 runs this file directly through type stripping. Never imported
 * by the gateway.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pollUntil, runId, smokeEnv } from "../../../scripts/lib/smoke.mjs";
import { estimateScenario, formatEstimate } from "./cost.ts";
import {
	assertNotProductionUrl,
	loadProductionTarget,
	type ProductionTarget,
} from "./guard.ts";
import {
	parseScenario,
	type Scenario,
	type SinkSpec,
	stepSink,
} from "./scenario.ts";
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

export type DeliveryAccounting = {
	/** Sends that got a 202. */
	accepted: number;
	sink_unique: number;
	sink_received: number;
	/**
	 * Positive when sends that were not 202 (e.g. a 503 after the D1 write)
	 * were delivered anyway, for example by the reconciler.
	 */
	unique_minus_accepted: number;
	/** max(0, accepted - sink_unique) once drained; null if the drain timed out. */
	lost: number | null;
	lost_note: string | null;
};

export type RunResult = {
	scenario: string;
	started_at: string;
	worker_version: string;
	steps: Summary[];
	drain_ms: number | null;
	delivery: DeliveryAccounting;
	sink_patch_errors: string[];
};

type Source = {
	id: string;
	ingress_url: string;
	secret: string;
};

/** Every live status counted by the admin overview (LIVE_STATUSES). */
const LIVE_KEYS = ["pending", "queued", "in_flight", "retrying", "paused"];

/** True once the overview reports no backlog left to drain. */
export function isDrained(live: Record<string, number>): boolean {
	return LIVE_KEYS.every((key) => (live[key] ?? 0) === 0);
}

/** Overview scoped to the bench project, so other traffic cannot block drain. */
export function overviewUrl(base: string, projectId: string): string {
	return `${base}/api/admin/v1/overview?project_id=${encodeURIComponent(projectId)}`;
}

export function sinkQuery(sink: SinkSpec): string {
	const params = new URLSearchParams();
	if (sink.delay_ms !== undefined) {
		params.set("delay_ms", String(sink.delay_ms));
	}
	if (sink.fail_pct !== undefined) {
		params.set("fail_pct", String(sink.fail_pct));
	}
	const query = params.toString();
	return query === "" ? "" : `?${query}`;
}

/**
 * Loss accounting. `lost` is only meaningful after the drain finished.
 * Sink uniqueness counts every delivered event, including sends that were
 * not answered with 202 but were stored and delivered later, so when
 * `unique_minus_accepted` > 0 the loss figure is only a lower bound.
 */
export function accountDelivery(
	accepted: number,
	sink: SinkStats,
	drained: boolean,
): DeliveryAccounting {
	const extra = sink.unique - accepted;
	let lost: number | null = null;
	let note: string | null = null;
	if (!drained) {
		note = "drain timed out";
	} else {
		lost = Math.max(0, accepted - sink.unique);
		if (extra > 0) {
			note = `${extra} delivered event(s) were not answered 202; lost is a lower bound`;
		}
	}
	return {
		accepted,
		sink_unique: sink.unique,
		sink_received: sink.received,
		unique_minus_accepted: extra,
		lost,
		lost_note: note,
	};
}

function accessHeaders(env: { token: string }) {
	return {
		"content-type": "application/json",
		authorization: `Bearer ${env.token}`,
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

type Provisioned = {
	projectId: string;
	destinationId: string;
	sources: Source[];
};

async function provision(
	fetchFn: typeof fetch,
	base: string,
	headers: Record<string, string>,
	scenario: Scenario,
	run: string,
	hookUrl: string,
): Promise<Provisioned> {
	const project = (await readJson(
		"create project",
		await fetchFn(`${base}/api/admin/v1/projects`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: `bench-${run}`, slug: `bench-${run}` }),
		}),
	)) as { id: string };
	const destination = (await readJson(
		"create destination",
		await fetchFn(`${base}/api/admin/v1/destinations`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				project_id: project.id,
				name: `bench-${run}`,
				url: `${hookUrl}${sinkQuery(stepSink(scenario, 0))}`,
			}),
		}),
	)) as { id: string };
	const sources: Source[] = [];
	for (let i = 0; i < scenario.sources; i++) {
		const secret = randomSecretBase64();
		const created = (await readJson(
			"create source",
			await fetchFn(`${base}/api/admin/v1/sources`, {
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
	return { projectId: project.id, destinationId: destination.id, sources };
}

export type SendTiming = {
	/** Scheduled send time on the `now` clock. */
	scheduledAt: number;
	/** Run start on the `now` clock; `sent_at` is relative to it. */
	t0: number;
	now: () => number;
	fetch: typeof fetch;
};

export async function sendOne(
	source: Source,
	body: string,
	webhookId: string,
	timing: SendTiming,
): Promise<SendResult> {
	const started = timing.now();
	const base = {
		late_ms: started - timing.scheduledAt,
		sent_at: started - timing.t0,
	};
	try {
		const res = await timing.fetch(source.ingress_url, {
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
		return {
			status: res.status,
			kind: "http",
			ms: timing.now() - timing.scheduledAt,
			...base,
		};
	} catch (err) {
		const name = (err as { name?: string } | null)?.name;
		return {
			status: 0,
			kind:
				name === "TimeoutError" || name === "AbortError"
					? "timeout"
					: "network",
			ms: timing.now() - timing.scheduledAt,
			...base,
		};
	}
}

async function waitForDrain(
	fetchFn: typeof fetch,
	url: string,
	headers: Record<string, string>,
	timeoutMs: number,
): Promise<number | null> {
	const started = Date.now();
	try {
		await pollUntil(
			async () => {
				const overview = (await readJson(
					"overview",
					await fetchFn(url, { headers }),
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

async function sinkStats(
	fetchFn: typeof fetch,
	sinkUrl: string,
	run: string,
): Promise<SinkStats> {
	const parsed = (await readJson(
		"sink stats",
		await fetchFn(`${sinkUrl}/r/${run}/stats`),
	)) as { unique: number; received: number };
	return { unique: parsed.unique, received: parsed.received };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export type RunDeps = {
	env: Record<string, string | undefined>;
	readFile: (path: string) => Promise<string>;
	production: ProductionTarget;
	fetch: typeof fetch;
	log: (line: string) => void;
	exit: (code: number) => never;
};

function defaultRunDeps(): RunDeps {
	return {
		env: process.env,
		readFile: (path) => readFile(path, "utf8"),
		production: loadProductionTarget(),
		fetch: (input, init) => fetch(input, init),
		log: (line) => console.error(line),
		exit: (code) => process.exit(code),
	};
}

export async function main(
	argv: string[],
	deps: RunDeps = defaultRunDeps(),
): Promise<void> {
	const { log, exit } = deps;
	const file = argv.find((arg) => !arg.startsWith("--"));
	if (!file) {
		log("usage: node src/run.ts <scenario.json> [--yes | --estimate]");
		return exit(2);
	}
	const scenario = parseScenario(JSON.parse(await deps.readFile(file)));
	log(formatEstimate(estimateScenario(scenario)));
	if (argv.includes("--estimate") || !argv.includes("--yes")) {
		log("bench: estimate only; re-run with --yes to send traffic");
		return;
	}
	const env = smokeEnv(deps.env);
	if (!env) {
		log("bench: missing one of HOOKFLARE_URL, HOOKFLARE_API_TOKEN, SINK_URL");
		return exit(2);
	}
	try {
		assertNotProductionUrl(env.url, deps.production);
	} catch (err) {
		log(`bench: ${(err as Error).message}`);
		return exit(2);
	}
	const fetchFn = deps.fetch;
	const base = env.url.replace(/\/$/, "");
	const sinkUrl = env.sinkUrl.replace(/\/$/, "");
	const headers = accessHeaders(env);
	const run = runId();
	const startedAt = new Date().toISOString();
	const hookUrl = `${sinkUrl}/r/${run}/hook`;

	const { projectId, destinationId, sources } = await provision(
		fetchFn,
		base,
		headers,
		scenario,
		run,
		hookUrl,
	);
	log(`bench: run ${run} with ${sources.length} sources`);

	const body = makeBody(scenario.body_bytes, `bench-${run}-`);
	const pending: Promise<SendResult>[] = [];
	const patches: Promise<void>[] = [];
	const patchErrors: string[] = [];
	const stepSizes = scenario.steps.map((s) =>
		Math.round(s.rate_per_s * s.duration_s),
	);
	const now = () => performance.now();
	const t0 = now();
	let n = 0;
	let step = 0;
	let stepEnd = stepSizes[0];
	for (const at of arrivals(scenario.steps)) {
		while (n >= stepEnd && step + 1 < stepSizes.length) {
			step++;
			stepEnd += stepSizes[step];
			const before = sinkQuery(stepSink(scenario, step - 1));
			const after = sinkQuery(stepSink(scenario, step));
			if (after !== before) {
				// Fire and forget: awaiting would delay the schedule.
				const index = step;
				patches.push(
					fetchFn(`${base}/api/admin/v1/destinations/${destinationId}`, {
						method: "PATCH",
						headers,
						body: JSON.stringify({
							url: `${hookUrl}${after}`,
							reason: `bench step ${index}`,
						}),
					})
						.then((res) => readJson(`sink switch at step ${index}`, res))
						.then(() => log(`bench: step ${index} sink ${after || "(none)"}`))
						.catch((err: Error) => {
							patchErrors.push(err.message);
						}),
				);
			}
		}
		const scheduledAt = t0 + at;
		const wait = scheduledAt - now();
		if (wait > 0) await sleep(wait);
		const source = sources[n % sources.length];
		pending.push(
			sendOne(source, body, `bench-${run}-${n}`, {
				scheduledAt,
				t0,
				now,
				fetch: fetchFn,
			}),
		);
		n++;
	}
	const results = await Promise.all(pending);
	await Promise.all(patches);

	const steps: Summary[] = [];
	let offset = 0;
	stepSizes.forEach((size, index) => {
		steps.push(
			summarize(
				results.slice(offset, offset + size),
				scenario.steps[index].rate_per_s,
			),
		);
		offset += size;
	});

	const drainMs = await waitForDrain(
		fetchFn,
		overviewUrl(base, projectId),
		headers,
		scenario.drain_timeout_s * 1000,
	);
	const sink = await sinkStats(fetchFn, sinkUrl, run);
	const accepted = results.filter(
		(r) => r.kind === "http" && r.status === 202,
	).length;
	const delivery = accountDelivery(accepted, sink, drainMs !== null);
	const result: RunResult = {
		scenario: scenario.name,
		started_at: startedAt,
		worker_version: deps.env.HOOKFLARE_WORKER_VERSION ?? "unknown",
		steps,
		drain_ms: drainMs,
		delivery,
		sink_patch_errors: patchErrors,
	};
	const dir = new URL("../results/", import.meta.url).pathname;
	await mkdir(dir, { recursive: true });
	const stamp = startedAt.replace(/[:.]/g, "-");
	await writeFile(
		`${dir}${scenario.name}-${stamp}.json`,
		JSON.stringify(result, null, "\t"),
		"utf8",
	);
	log(
		`bench: accepted=${accepted} unique=${sink.unique} lost=${delivery.lost ?? "null"}${delivery.lost_note ? ` (${delivery.lost_note})` : ""} drain_ms=${drainMs}`,
	);
}

const invoked = (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("/run.ts");
if (invoked) {
	await main(process.argv.slice(2));
}
