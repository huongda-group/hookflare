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

export const IN_FLIGHT_WAIT_MIN_MS = 5_000;
export const IN_FLIGHT_WAIT_MAX_MS = 30_000;

const clamp = (v: number, lo: number, hi: number) =>
	Math.min(hi, Math.max(lo, v));

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
			 CREATE TABLE IF NOT EXISTS bucket (k INTEGER PRIMARY KEY CHECK (k = 0), tokens REAL NOT NULL, at INTEGER NOT NULL);`,
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
						retryAfterMs: clamp(
							(earliest ?? now) - now,
							IN_FLIGHT_WAIT_MIN_MS,
							IN_FLIGHT_WAIT_MAX_MS,
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
						retryAfterMs: Math.ceil(((1 - tokens) / cap) * 1000),
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

	private saveBucket(tokens: number, at: number): void {
		this.sql.exec(
			"INSERT INTO bucket (k, tokens, at) VALUES (0, ?, ?) ON CONFLICT (k) DO UPDATE SET tokens = excluded.tokens, at = excluded.at",
			tokens,
			at,
		);
	}
}
