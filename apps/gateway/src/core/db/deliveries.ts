import type { SQL } from "drizzle-orm";
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { AttemptOutcome } from "../../delivery/classify";
import type { Deps } from "../../deps";
import { newId } from "../ids";
import {
	type DeliveryRow,
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

/** Spec §8.2: only claimable deliveries become dead; a live lease is left to its worker. */
export async function markDeadFromDlq(
	deps: Deps,
	deliveryId: string,
): Promise<boolean> {
	const result = await deps.db
		.update(deliveries)
		.set({
			status: "dead",
			lastError: "dlq: infra retries exhausted",
			leaseUntil: null,
			nextAttemptAt: null,
			completedAt: deps.now(),
		})
		.where(and(eq(deliveries.id, deliveryId), claimable(deps.now())));
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
