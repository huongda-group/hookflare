import { DurableObject } from "cloudflare:workers";

export type SinkEnv = {
	SHARD: DurableObjectNamespace<SinkShard>;
};

export type ShardStats = {
	received: number;
	unique: number;
	by_status: Record<string, number>;
	first_at: number | null;
	last_at: number | null;
};

/** Stored data expires after 7 days through the DO alarm (spec §5.2). */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ALARM_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Cap for `ids()`: it is for smoke-sized runs, not load runs. */
const MAX_IDS = 1000;

/**
 * One of 16 SQLite-backed shards. Webhook IDs hash to a shard with
 * `shardFor`, so each ID lives on exactly one shard and the per-shard
 * `COUNT(DISTINCT webhook_id)` values sum to the exact unique count.
 */
export class SinkShard extends DurableObject<SinkEnv> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: SinkEnv) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS hits (
				run TEXT NOT NULL,
				webhook_id TEXT NOT NULL,
				status INTEGER NOT NULL,
				at INTEGER NOT NULL
			)`,
		);
	}

	async record(
		run: string,
		id: string,
		status: number,
		at: number,
	): Promise<void> {
		this.sql.exec(
			"INSERT INTO hits (run, webhook_id, status, at) VALUES (?, ?, ?, ?)",
			run,
			id,
			status,
			at,
		);
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
		}
	}

	async stats(run: string): Promise<ShardStats> {
		const agg = this.sql
			.exec<{
				received: number;
				uniq: number;
				first: number | null;
				last: number | null;
			}>(
				`SELECT COUNT(*) AS received,
					COUNT(DISTINCT webhook_id) AS uniq,
					MIN(at) AS first,
					MAX(at) AS last
				FROM hits WHERE run = ?`,
				run,
			)
			.one();
		const by_status: Record<string, number> = {};
		for (const row of this.sql
			.exec<{ status: number; n: number }>(
				"SELECT status, COUNT(*) AS n FROM hits WHERE run = ? GROUP BY status",
				run,
			)
			.toArray()) {
			by_status[String(row.status)] = row.n;
		}
		return {
			received: agg.received,
			unique: agg.uniq,
			by_status,
			first_at: agg.first,
			last_at: agg.last,
		};
	}

	/** Distinct webhook IDs of a run on this shard, at most MAX_IDS. */
	async ids(run: string): Promise<string[]> {
		return this.sql
			.exec<{ webhook_id: string }>(
				"SELECT DISTINCT webhook_id FROM hits WHERE run = ? ORDER BY webhook_id LIMIT ?",
				run,
				MAX_IDS,
			)
			.toArray()
			.map((row) => row.webhook_id);
	}

	async clear(run: string): Promise<void> {
		this.sql.exec("DELETE FROM hits WHERE run = ?", run);
	}

	async alarm(): Promise<void> {
		this.sql.exec("DELETE FROM hits WHERE at < ?", Date.now() - RETENTION_MS);
		await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
	}
}
