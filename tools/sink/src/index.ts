import { type ShardStats, type SinkEnv, SinkShard } from "./shard";

export { SinkShard, setSleep, shardFor };

export type Stats = {
	received: number;
	unique: number;
	duplicates: number;
	by_status: Record<string, number>;
	first_at: number;
	last_at: number;
};

const SHARD_COUNT = 16;
const MAX_DELAY_MS = 30000;

let sleep: (ms: number) => Promise<void> = (ms) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Test seam: stub the `delay_ms` wait so tests do not sleep for real. */
function setSleep(fn: (ms: number) => Promise<void>): void {
	sleep = fn;
}

/** FNV-1a 32-bit of the ID, modulo the shard count. */
function shardFor(webhookId: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < webhookId.length; i++) {
		h ^= webhookId.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) % SHARD_COUNT;
}

function stubFor(
	env: SinkEnv,
	webhookId: string,
): DurableObjectStub<SinkShard> {
	return env.SHARD.get(env.SHARD.idFromName(`shard-${shardFor(webhookId)}`));
}

function shardStub(env: SinkEnv, n: number): DurableObjectStub<SinkShard> {
	return env.SHARD.get(env.SHARD.idFromName(`shard-${n}`));
}

function numParam(url: URL, name: string, def: number): number {
	const raw = url.searchParams.get(name);
	if (raw === null) {
		return def;
	}
	const n = Number(raw);
	return Number.isFinite(n) ? n : def;
}

async function handleHook(
	request: Request,
	env: SinkEnv,
	run: string,
): Promise<Response> {
	const id = request.headers.get("webhook-id");
	if (!id) {
		return Response.json({ error: "missing_webhook_id" }, { status: 400 });
	}
	const url = new URL(request.url);
	const status = Math.trunc(numParam(url, "status", 200));
	const delayMs = Math.min(
		Math.max(numParam(url, "delay_ms", 0), 0),
		MAX_DELAY_MS,
	);
	const failPct = numParam(url, "fail_pct", 0);
	const chosen = Math.random() * 100 < failPct ? 503 : status;
	await stubFor(env, id).record(run, id, chosen, Date.now());
	if (delayMs > 0) {
		await sleep(delayMs);
	}
	return new Response("ok", { status: chosen });
}

async function handleStats(env: SinkEnv, run: string): Promise<Response> {
	const shards: ShardStats[] = await Promise.all(
		Array.from({ length: SHARD_COUNT }, (_, n) => shardStub(env, n).stats(run)),
	);
	const body: Stats = {
		received: 0,
		unique: 0,
		duplicates: 0,
		by_status: {},
		first_at: 0,
		last_at: 0,
	};
	for (const s of shards) {
		body.received += s.received;
		body.unique += s.unique;
		for (const [status, n] of Object.entries(s.by_status)) {
			body.by_status[status] = (body.by_status[status] ?? 0) + n;
		}
		if (
			s.first_at !== null &&
			(body.first_at === 0 || s.first_at < body.first_at)
		) {
			body.first_at = s.first_at;
		}
		if (s.last_at !== null && s.last_at > body.last_at) {
			body.last_at = s.last_at;
		}
	}
	body.duplicates = body.received - body.unique;
	return Response.json(body);
}

async function handleClear(env: SinkEnv, run: string): Promise<Response> {
	await Promise.all(
		Array.from({ length: SHARD_COUNT }, (_, n) => shardStub(env, n).clear(run)),
	);
	return new Response(null, { status: 204 });
}

function notFound(): Response {
	return Response.json({ error: "not_found" }, { status: 404 });
}

export default {
	async fetch(request: Request, env: SinkEnv): Promise<Response> {
		const parts = new URL(request.url).pathname.split("/");
		// ["", "r", run, action?]
		if (parts.length < 3 || parts[1] !== "r" || !parts[2]) {
			return notFound();
		}
		const run = parts[2];
		if (
			request.method === "POST" &&
			parts.length === 4 &&
			parts[3] === "hook"
		) {
			return handleHook(request, env, run);
		}
		if (
			request.method === "GET" &&
			parts.length === 4 &&
			parts[3] === "stats"
		) {
			return handleStats(env, run);
		}
		if (request.method === "DELETE" && parts.length === 3) {
			return handleClear(env, run);
		}
		return notFound();
	},
};
