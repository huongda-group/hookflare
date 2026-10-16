import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "../env";

export type AcquireRequest = {
	maxInFlight: number | null;
	ratePerS: number | null;
	/** timeout + LEASE_GRACE_MS: a slot never outlives the D1 lease (M5-3). */
	leaseMs: number;
};
export type AcquireResult =
	| { ok: true; slotId: string }
	| { ok: false; reason: "in_flight" | "rate"; retryAfterMs: number };
export type LimiterStub = {
	acquire(req: AcquireRequest): Promise<AcquireResult>;
	release(slotId: string): Promise<void>;
};

/**
 * In-flight rejections wait at most this long: a slot is usually released when its
 * delivery finishes, long before its lease expires.
 */
export const IN_FLIGHT_RETRY_MS = 5_000;
/** Rate rejections are spread over successive token times, up to this far ahead. */
export const RATE_RETRY_MAX_MS = 30_000;

/**
 * Spec §5.2. A pure counter: the consumer passes the limits on every call,
 * so a policy change applies to the next delivery (M5-2). All state lives in
 * SQLite storage, so eviction resets nothing (M5-4).
 */
export class DestinationLimiter
	extends DurableObject<AppEnv>
	implements LimiterStub
{
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: AppEnv) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS slots (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
			 CREATE TABLE IF NOT EXISTS bucket (k INTEGER PRIMARY KEY CHECK (k = 0), tokens REAL NOT NULL, at INTEGER NOT NULL);
			 CREATE TABLE IF NOT EXISTS rate_hint (k INTEGER PRIMARY KEY CHECK (k = 0), next_at INTEGER NOT NULL);`,
		);
	}

	async acquire(req: AcquireRequest): Promise<AcquireResult> {
		return this.acquireAt(req, Date.now());
	}

	async release(slotId: string): Promise<void> {
		this.releaseSlot(slotId);
	}

	acquireAt(req: AcquireRequest, now: number): AcquireResult {
		return this.ctx.storage.transactionSync(() => {
			// 1. Expired slots belong to workers that died without releasing (M5-3).
			this.sql.exec("DELETE FROM slots WHERE expires_at <= ?", now);

			// 2. Concurrency.
			if (req.maxInFlight !== null) {
				const { n, earliest } = this.sql
					.exec<{ n: number; earliest: number | null }>(
						"SELECT COUNT(*) AS n, MIN(expires_at) AS earliest FROM slots",
					)
					.one();
				if (n >= req.maxInFlight) {
					return {
						ok: false,
						reason: "in_flight",
						retryAfterMs: Math.min(
							Math.max(0, (earliest ?? now) - now),
							IN_FLIGHT_RETRY_MS,
						),
					};
				}
			}

			// 3. Rate: token bucket with at most one second of burst.
			if (req.ratePerS !== null) {
				const cap = req.ratePerS;
				const row = this.sql
					.exec<{ tokens: number; at: number }>(
						"SELECT tokens, at FROM bucket WHERE k = 0",
					)
					.toArray()[0];
				const elapsedS = row ? Math.max(0, now - row.at) / 1000 : 0;
				const tokens = row ? Math.min(cap, row.tokens + elapsedS * cap) : cap;
				if (tokens < 1) {
					this.saveBucket(tokens, now);
					return {
						ok: false,
						reason: "rate",
						retryAfterMs: this.rateHint(tokens, cap, now),
					};
				}
				this.saveBucket(tokens - 1, now);
			}

			// 4. Every accepted call gets a slot, so release is uniform.
			const slotId = crypto.randomUUID();
			this.sql.exec(
				"INSERT INTO slots (id, expires_at) VALUES (?, ?)",
				slotId,
				now + req.leaseMs,
			);
			return { ok: true, slotId };
		});
	}

	releaseSlot(slotId: string): void {
		this.sql.exec("DELETE FROM slots WHERE id = ?", slotId);
	}

	/**
	 * Each rejected caller is told a later token time than the one before, so a
	 * backlog returns spread over time instead of all at the next token. A hint
	 * reserves nothing: whoever comes first when a token is back takes it.
	 */
	private rateHint(tokens: number, ratePerS: number, now: number): number {
		const intervalMs = 1000 / ratePerS;
		const nextToken = now + Math.ceil((1 - tokens) * intervalMs);
		const row = this.sql
			.exec<{ next_at: number }>("SELECT next_at FROM rate_hint WHERE k = 0")
			.toArray()[0];
		const at = Math.min(
			Math.max(row?.next_at ?? 0, nextToken),
			now + RATE_RETRY_MAX_MS,
		);
		this.sql.exec(
			"INSERT INTO rate_hint (k, next_at) VALUES (0, ?) ON CONFLICT (k) DO UPDATE SET next_at = excluded.next_at",
			Math.ceil(at + intervalMs),
		);
		return at - now;
	}

	private saveBucket(tokens: number, at: number): void {
		this.sql.exec(
			"INSERT INTO bucket (k, tokens, at) VALUES (0, ?, ?) ON CONFLICT (k) DO UPDATE SET tokens = excluded.tokens, at = excluded.at",
			tokens,
			at,
		);
	}
}
