/**
 * B5 admin query timer: `node src/queries.ts [--reps 10] [--project <id>]
 * [--source <id>] [--destination <id>]`.
 *
 * Reads HOOKFLARE_URL and HOOKFLARE_API_TOKEN,
 * refuses a production URL, then issues each read-only admin query of
 * spec §6 B5 `--reps` times in sequence and prints p50/p95/max per query
 * (wall time from request to fully read body, so it includes network RTT;
 * compare against a cheap baseline such as `overview: 24h`). Results are
 * also written to `results/b5-queries-<iso>.json`.
 *
 * Not covered: the stats rollup has no admin API trigger (time it from the
 * scheduled handler's logs), and POST /archives/run mutates, so only the
 * archive preview is timed here; time a real run from its batch record.
 *
 * Node 24 runs this file directly through type stripping.
 */

import { mkdir, writeFile } from "node:fs/promises";
import {
	assertNotProductionUrl,
	loadProductionTarget,
	type ProductionTarget,
} from "./guard.ts";
import { percentiles } from "./stats.ts";

export type Query = { name: string; path: string };

export type QueryScope = {
	projectId?: string;
	sourceId?: string;
	destinationId?: string;
};

export type QueryTiming = Query & {
	p50: number;
	p95: number;
	max: number;
	by_status: Record<string, number>;
};

const API = "/api/admin/v1";

function withParams(
	path: string,
	params: [string, string | undefined][],
): string {
	const search = new URLSearchParams();
	for (const [key, value] of params) {
		if (value !== undefined && value !== "") search.append(key, value);
	}
	const query = search.toString();
	return query === "" ? `${API}${path}` : `${API}${path}?${query}`;
}

/**
 * The B5 read paths: event search with sparse filters (selective status,
 * HTTP status, and a provider_event_id that matches nothing), the failures
 * views, overview ranges, destination stats, and the archive preview.
 */
export function b5Queries(scope: QueryScope): Query[] {
	const project: [string, string | undefined] = ["project_id", scope.projectId];
	const source: [string, string | undefined] = ["source_id", scope.sourceId];
	const destination: [string, string | undefined] = [
		"destination_id",
		scope.destinationId,
	];
	return [
		{ name: "events: latest page", path: withParams("/events", [project]) },
		{
			name: "events: status=dead",
			path: withParams("/events", [["status", "dead"], project, source]),
		},
		{
			name: "events: http_status=500",
			path: withParams("/events", [
				["http_status", "500"],
				project,
				destination,
			]),
		},
		// The API only accepts provider_event_id together with source_id.
		...(scope.sourceId
			? [
					{
						name: "events: provider_event_id miss",
						path: withParams("/events", [
							["provider_event_id", "b5-no-such-event"],
							project,
							source,
						]),
					},
				]
			: []),
		{
			name: "events: failed_final, last 7 days",
			path: withParams("/events", [
				["status", "failed_final"],
				["from", "-7d"],
				project,
			]),
		},
		{ name: "failures: unresolved", path: withParams("/failures", [project]) },
		{
			name: "failures: dead",
			path: withParams("/failures", [["status", "dead"], project, destination]),
		},
		{
			name: "overview: 24h",
			path: withParams("/overview", [["range", "24h"], project]),
		},
		{
			name: "overview: 30d",
			path: withParams("/overview", [["range", "30d"], project]),
		},
		{
			name: "destinations: stats",
			path: withParams("/destinations/stats", [project]),
		},
		{ name: "archives: preview", path: withParams("/archives/preview", []) },
	];
}

/** Resolve relative `from=-7d` placeholders to epoch ms at run time. */
function resolvePath(path: string, nowMs: number): string {
	return path.replace(/([?&]from=)-(\d+)d/, (_, key: string, days: string) => {
		return `${key}${nowMs - Number(days) * 86_400_000}`;
	});
}

export type TimeOptions = {
	base: string;
	headers: Record<string, string>;
	reps: number;
	fetch: typeof fetch;
	now: () => number;
	wallClock?: () => number;
};

export async function timeQuery(
	query: Query,
	opts: TimeOptions,
): Promise<QueryTiming> {
	const samples: number[] = [];
	const by_status: Record<string, number> = {};
	const url = `${opts.base}${resolvePath(query.path, (opts.wallClock ?? Date.now)())}`;
	for (let i = 0; i < opts.reps; i++) {
		const started = opts.now();
		let key: string;
		try {
			const res = await opts.fetch(url, { headers: opts.headers });
			await res.text().catch(() => "");
			key = String(res.status);
		} catch {
			key = "error";
		}
		samples.push(opts.now() - started);
		by_status[key] = (by_status[key] ?? 0) + 1;
	}
	const p = percentiles(samples, [50, 95]);
	return {
		...query,
		p50: p.p50,
		p95: p.p95,
		max: samples.reduce((a, b) => Math.max(a, b), 0),
		by_status,
	};
}

export function formatReport(timings: QueryTiming[]): string {
	const width = Math.max(...timings.map((t) => t.name.length));
	return timings
		.map((t) => {
			const statuses = Object.entries(t.by_status)
				.map(([status, count]) => `${status}×${count}`)
				.join(" ");
			return `${t.name.padEnd(width)}  p50 ${Math.round(t.p50)} ms  p95 ${Math.round(t.p95)} ms  max ${Math.round(t.max)} ms  ${statuses}`;
		})
		.join("\n");
}

export type QueryDeps = {
	env: Record<string, string | undefined>;
	production: ProductionTarget;
	fetch: typeof fetch;
	now: () => number;
	log: (line: string) => void;
	exit: (code: number) => never;
	/** Writes the JSON report; omitted in tests. */
	save?: (timings: QueryTiming[]) => Promise<void>;
};

function flag(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

async function saveReport(timings: QueryTiming[]): Promise<void> {
	const dir = new URL("../results/", import.meta.url).pathname;
	await mkdir(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	await writeFile(
		`${dir}b5-queries-${stamp}.json`,
		JSON.stringify(timings, null, "\t"),
		"utf8",
	);
}

function defaultDeps(): QueryDeps {
	return {
		env: process.env,
		production: loadProductionTarget(),
		fetch: (input, init) => fetch(input, init),
		now: () => performance.now(),
		log: (line) => console.error(line),
		exit: (code) => process.exit(code),
		save: saveReport,
	};
}

export async function main(
	argv: string[],
	deps: QueryDeps = defaultDeps(),
): Promise<void> {
	const { log, exit } = deps;
	const reps = Number(flag(argv, "reps") ?? "10");
	const url = deps.env.HOOKFLARE_URL ?? "";
	const token = deps.env.HOOKFLARE_API_TOKEN ?? "";
	if (!Number.isInteger(reps) || reps < 1 || !url || !token) {
		log(
			"usage: HOOKFLARE_URL=… HOOKFLARE_API_TOKEN=… node src/queries.ts [--reps 10] [--project <id>] [--source <id>] [--destination <id>]",
		);
		return exit(2);
	}
	try {
		assertNotProductionUrl(url, deps.production);
	} catch (err) {
		log(`queries: ${(err as Error).message}`);
		return exit(2);
	}
	const base = url.replace(/\/$/, "");
	const headers = {
		authorization: `Bearer ${token}`,
	};
	const queries = b5Queries({
		projectId: flag(argv, "project"),
		sourceId: flag(argv, "source"),
		destinationId: flag(argv, "destination"),
	});
	const timings: QueryTiming[] = [];
	for (const query of queries) {
		timings.push(
			await timeQuery(query, {
				base,
				headers,
				reps,
				fetch: deps.fetch,
				now: deps.now,
			}),
		);
	}
	log(formatReport(timings));
	await deps.save?.(timings);
}

const invoked = (process.argv[1] ?? "")
	.replace(/\\/g, "/")
	.endsWith("/queries.ts");
if (invoked) {
	await main(process.argv.slice(2));
}
