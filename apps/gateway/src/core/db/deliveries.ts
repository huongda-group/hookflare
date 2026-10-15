import type { SQL } from "drizzle-orm";
import {
	and,
	asc,
	desc,
	eq,
	getTableColumns,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	lte,
	ne,
	notExists,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { AttemptOutcome } from "../../delivery/classify";
import type { Db, Deps } from "../../deps";
import { chunks } from "../enqueue";
import { newId } from "../ids";
import {
	type DeliveryRow,
	type DeliveryStatus,
	type DestinationRow,
	deliveries,
	deliveryAttempts,
	destinations,
	type WebhookEventRow,
	webhookEvents,
} from "./schema";

export type DeliveryContext = {
	delivery: DeliveryRow;
	event: WebhookEventRow;
	destination: DestinationRow;
};

const CLAIMABLE = ["pending", "queued", "retrying"] as const;

/** Spec §7: a delivery a consumer may take, including one whose lease expired. */
export function claimable(now: number) {
	return or(
		inArray(deliveries.status, CLAIMABLE),
		and(eq(deliveries.status, "in_flight"), lt(deliveries.leaseUntil, now)),
	) as SQL;
}

export function isClaimable(d: DeliveryRow, now: number): boolean {
	return (
		(CLAIMABLE as readonly string[]).includes(d.status) ||
		(d.status === "in_flight" && d.leaseUntil !== null && d.leaseUntil < now)
	);
}

export async function loadDeliveryContext(
	deps: Deps,
	deliveryId: string,
): Promise<DeliveryContext | null> {
	const [row] = await deps.db
		.select({
			delivery: deliveries,
			event: webhookEvents,
			destination: destinations,
		})
		.from(deliveries)
		.innerJoin(webhookEvents, eq(webhookEvents.id, deliveries.eventId))
		.innerJoin(destinations, eq(destinations.id, deliveries.destinationId))
		.where(eq(deliveries.id, deliveryId))
		.limit(1);
	return row ?? null;
}

/** Ends a delivery that never reached the backend. Never overwrites a handled delivery. */
export async function finishWithoutAttempt(
	deps: Deps,
	deliveryId: string,
	lastError: string,
): Promise<void> {
	const now = deps.now();
	await deps.db
		.update(deliveries)
		.set({
			status: "failed_final",
			lastError,
			completedAt: now,
			leaseUntil: null,
			nextAttemptAt: null,
		})
		.where(and(eq(deliveries.id, deliveryId), claimable(now)));
}

/** Parks a delivery of a paused destination until Resume (spec §7 step 3). */
export async function holdDelivery(
	deps: Deps,
	deliveryId: string,
): Promise<void> {
	await deps.db
		.update(deliveries)
		.set({ status: "paused", leaseUntil: null, nextAttemptAt: null })
		.where(and(eq(deliveries.id, deliveryId), claimable(deps.now())));
}

/**
 * Takes the lease until `leaseUntil` (also the fencing token, spec §7.2).
 * Returns attempt_count at lease time, or null when another worker holds it.
 */
export async function acquireLease(
	deps: Deps,
	deliveryId: string,
	leaseUntil: number,
): Promise<number | null> {
	const [row] = await deps.db
		.update(deliveries)
		.set({ status: "in_flight", leaseUntil, nextAttemptAt: null })
		.where(and(eq(deliveries.id, deliveryId), claimable(deps.now())))
		.returning({ attemptCount: deliveries.attemptCount });
	return row?.attemptCount ?? null;
}

/**
 * Records one attempt, fenced by the lease. Both statements check the same
 * lease in one transaction (the attempt insert runs first so its guard sees
 * the lease before the update clears it). false = lease lost, nothing written.
 */
export async function recordLeasedAttempt(
	deps: Deps,
	deliveryId: string,
	a: {
		attemptNo: number;
		startedAt: number;
		durationMs: number;
		outcome: AttemptOutcome;
		snippet: string | null;
		leaseUntil: number;
	},
): Promise<boolean> {
	const now = deps.now();
	const { outcome } = a;
	const retrying = outcome.status === "retrying";
	const [, update] = await deps.db.batch([
		deps.db.insert(deliveryAttempts).select(sql`
			SELECT ${newId("att", a.startedAt)}, ${deliveryId}, ${a.attemptNo},
				${a.startedAt}, ${a.durationMs}, ${outcome.httpStatus},
				${outcome.errorKind}, ${outcome.error}, ${a.snippet}
			WHERE EXISTS (SELECT 1 FROM deliveries WHERE id = ${deliveryId}
				AND status = 'in_flight' AND lease_until = ${a.leaseUntil})`),
		deps.db
			.update(deliveries)
			.set({
				attemptCount: a.attemptNo,
				status: outcome.status,
				lastHttpStatus: outcome.httpStatus,
				lastError: outcome.error,
				leaseUntil: null,
				nextAttemptAt: retrying ? now + outcome.delaySeconds * 1000 : null,
				...(retrying ? { enqueuedAt: now } : {}),
				completedAt: retrying ? null : now,
			})
			.where(
				and(
					eq(deliveries.id, deliveryId),
					eq(deliveries.status, "in_flight"),
					eq(deliveries.leaseUntil, a.leaseUntil),
				),
			),
	]);
	return (
		(update as unknown as { meta: { changes: number } }).meta.changes === 1
	);
}

/**
 * Spec §8.2: only claimable deliveries become dead; a live lease is left to its worker,
 * and a retry whose backoff is not yet due is left to its delayed message.
 */
export async function markDeadFromDlq(
	deps: Deps,
	deliveryId: string,
): Promise<boolean> {
	const now = deps.now();
	const result = await deps.db
		.update(deliveries)
		.set({
			status: "dead",
			lastError: "dlq: infra retries exhausted",
			leaseUntil: null,
			nextAttemptAt: null,
			completedAt: now,
		})
		.where(
			and(
				eq(deliveries.id, deliveryId),
				claimable(now),
				or(
					ne(deliveries.status, "retrying"),
					isNull(deliveries.nextAttemptAt),
					lte(deliveries.nextAttemptAt, now),
				),
			),
		);
	return result.meta.changes === 1;
}

/** Moves up to `limit` paused deliveries back to pending (oldest first). */
export async function releasePausedDeliveries(
	deps: Deps,
	destinationId: string,
	limit: number,
): Promise<string[]> {
	const oldest = deps.db
		.select({ id: deliveries.id })
		.from(deliveries)
		.where(
			and(
				eq(deliveries.destinationId, destinationId),
				eq(deliveries.status, "paused"),
			),
		)
		.orderBy(asc(deliveries.createdAt))
		.limit(limit);
	const rows = await deps.db
		.update(deliveries)
		.set({ status: "pending", enqueuedAt: null })
		.where(and(eq(deliveries.status, "paused"), inArray(deliveries.id, oldest)))
		.returning({ id: deliveries.id });
	return rows.map((r) => r.id);
}

/** ids must fit one D1 query (≤ ENQUEUE_CHUNK). */
export async function markQueuedMany(deps: Deps, ids: string[]): Promise<void> {
	await deps.db
		.update(deliveries)
		.set({ status: "queued", enqueuedAt: deps.now() })
		.where(and(inArray(deliveries.id, ids), eq(deliveries.status, "pending")));
}

const FAILED = ["failed_final", "dead"] as const;

export type FailureFilter = {
	statuses?: (typeof FAILED)[number][];
	projectId?: string;
	destinationId?: string;
	from?: number;
	to?: number;
	/** Hide failures that already have a newer replay for the same event and destination. */
	unresolved: boolean;
	after?: { at: number; id: string };
	limit: number;
};

/** Spec §8.4. Ordered by (completed_at, id) desc; returns limit + 1 rows. */
export async function listFailures(db: Db, f: FailureFilter) {
	const newer = alias(deliveries, "newer");
	const where: (SQL | undefined)[] = [
		inArray(deliveries.status, f.statuses?.length ? f.statuses : [...FAILED]),
		f.projectId ? eq(deliveries.projectId, f.projectId) : undefined,
		f.destinationId ? eq(deliveries.destinationId, f.destinationId) : undefined,
		f.from !== undefined ? gte(deliveries.completedAt, f.from) : undefined,
		f.to !== undefined ? lte(deliveries.completedAt, f.to) : undefined,
		f.after
			? or(
					lt(deliveries.completedAt, f.after.at),
					and(
						eq(deliveries.completedAt, f.after.at),
						lt(deliveries.id, f.after.id),
					),
				)
			: undefined,
		f.unresolved
			? notExists(
					db
						.select({ one: sql`1` })
						.from(newer)
						.where(
							and(
								eq(newer.eventId, deliveries.eventId),
								eq(newer.destinationId, deliveries.destinationId),
								eq(newer.kind, "replay"),
								gt(newer.id, deliveries.id),
							),
						),
				)
			: undefined,
	];
	return db
		.select({
			...getTableColumns(deliveries),
			sourceId: webhookEvents.sourceId,
			receivedAt: webhookEvents.receivedAt,
		})
		.from(deliveries)
		.innerJoin(webhookEvents, eq(webhookEvents.id, deliveries.eventId))
		.where(and(...where))
		.orderBy(desc(deliveries.completedAt), desc(deliveries.id))
		.limit(f.limit + 1)
		.all();
}

/** Newest replay per (event, destination), keyed "<eventId>|<destinationId>". */
export async function latestReplays(
	db: Db,
	pairs: { eventId: string; destinationId: string }[],
): Promise<Map<string, DeliveryRow>> {
	const out = new Map<string, DeliveryRow>();
	const eventIds = [...new Set(pairs.map((p) => p.eventId))];
	for (const chunk of chunks(eventIds)) {
		const rows = await db
			.select()
			.from(deliveries)
			.where(
				and(inArray(deliveries.eventId, chunk), eq(deliveries.kind, "replay")),
			)
			.orderBy(asc(deliveries.id))
			.all();
		for (const r of rows) out.set(`${r.eventId}|${r.destinationId}`, r);
	}
	return out;
}

export async function getDeliveriesByIds(
	db: Db,
	ids: string[],
): Promise<DeliveryRow[]> {
	const out: DeliveryRow[] = [];
	for (const chunk of chunks(ids)) {
		out.push(
			...(await db
				.select()
				.from(deliveries)
				.where(inArray(deliveries.id, chunk))
				.all()),
		);
	}
	return out;
}

export async function getInitialDelivery(
	db: Db,
	eventId: string,
): Promise<DeliveryRow | undefined> {
	return db
		.select()
		.from(deliveries)
		.where(and(eq(deliveries.eventId, eventId), eq(deliveries.kind, "initial")))
		.get();
}

const TERMINAL: DeliveryStatus[] = ["delivered", "failed_final", "dead"];

/** "<eventId>|<destinationId>" of replays still in the pipeline (spec §9.2). */
export async function activeReplays(
	db: Db,
	eventIds: string[],
): Promise<Set<string>> {
	const out = new Set<string>();
	for (const chunk of chunks(eventIds)) {
		const rows = await db
			.select({
				eventId: deliveries.eventId,
				destinationId: deliveries.destinationId,
			})
			.from(deliveries)
			.where(
				and(
					inArray(deliveries.eventId, chunk),
					eq(deliveries.kind, "replay"),
					notInArray(deliveries.status, TERMINAL),
				),
			)
			.all();
		for (const r of rows) out.add(`${r.eventId}|${r.destinationId}`);
	}
	return out;
}
