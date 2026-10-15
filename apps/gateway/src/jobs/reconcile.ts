import { and, asc, eq, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import { deliveries, destinations } from "../core/db/schema";
import { enqueueThenMark } from "../core/enqueue";
import type { Deps } from "../deps";

export const RECONCILE_LIMIT = 500;
const PENDING_GRACE_MS = 60_000;
const LEASE_STALE_MS = 5 * 60_000;
const RETRY_OVERDUE_MS = 15 * 60_000;
const QUEUED_STALE_MS = 30 * 60_000;

export type ReconcileReport = {
	pending: number;
	expired_leases: number;
	overdue_retries: number;
	stale_queued: number;
	resumed_paused: number;
	failed_paused: number;
	send_failed: number;
};

type DeliveryPatch = Partial<typeof deliveries.$inferInsert>;

/** Recovers lost messages only; it never moves a next_attempt_at earlier (spec §8.1). */
export async function reconcile(deps: Deps): Promise<ReconcileReport> {
	const now = deps.now();
	let budget = RECONCILE_LIMIT;
	const report: ReconcileReport = {
		pending: 0,
		expired_leases: 0,
		overdue_retries: 0,
		stale_queued: 0,
		resumed_paused: 0,
		failed_paused: 0,
		send_failed: 0,
	};

	// Select, send, then update with the same condition so a row that moved meanwhile is left alone.
	const resend = async (where: SQL, set: DeliveryPatch): Promise<number> => {
		if (budget <= 0) return 0;
		const rows = await deps.db
			.select({ id: deliveries.id })
			.from(deliveries)
			.where(where)
			.orderBy(asc(deliveries.createdAt))
			.limit(budget);
		budget -= rows.length;
		const result = await enqueueThenMark(
			deps,
			rows.map((r) => r.id),
			(chunk) =>
				deps.db
					.update(deliveries)
					.set(set)
					.where(and(inArray(deliveries.id, chunk), where)),
		);
		report.send_failed += result.sendFailed;
		return result.sent;
	};

	const pausedOf = (
		destinationStatus: "active" | "disabled",
		set: DeliveryPatch,
	) => {
		if (budget <= 0) return Promise.resolve([]);
		const ids = deps.db
			.select({ id: deliveries.id })
			.from(deliveries)
			.innerJoin(destinations, eq(destinations.id, deliveries.destinationId))
			.where(
				and(
					eq(deliveries.status, "paused"),
					eq(destinations.status, destinationStatus),
				),
			)
			.limit(budget);
		return deps.db
			.update(deliveries)
			.set(set)
			.where(and(eq(deliveries.status, "paused"), inArray(deliveries.id, ids)))
			.returning({ id: deliveries.id });
	};

	// (a) pending, never enqueued (ingress enqueue failed).
	report.pending = await resend(
		and(
			eq(deliveries.status, "pending"),
			isNull(deliveries.enqueuedAt),
			lt(deliveries.createdAt, now - PENDING_GRACE_MS),
		) as SQL,
		{ status: "queued", enqueuedAt: now },
	);
	// (b) a worker died holding the lease; no attempt is counted.
	report.expired_leases = await resend(
		and(
			eq(deliveries.status, "in_flight"),
			lt(deliveries.leaseUntil, now - LEASE_STALE_MS),
		) as SQL,
		{
			status: "retrying",
			nextAttemptAt: now,
			leaseUntil: null,
			enqueuedAt: now,
		},
	);
	// (c) the delayed retry message was lost.
	report.overdue_retries = await resend(
		and(
			eq(deliveries.status, "retrying"),
			lt(deliveries.nextAttemptAt, now - RETRY_OVERDUE_MS),
			or(
				isNull(deliveries.enqueuedAt),
				lt(deliveries.enqueuedAt, now - RETRY_OVERDUE_MS),
			),
		) as SQL,
		{ enqueuedAt: now },
	);
	// (d) queued but never consumed.
	report.stale_queued = await resend(
		and(
			eq(deliveries.status, "queued"),
			lt(deliveries.enqueuedAt, now - QUEUED_STALE_MS),
		) as SQL,
		{ enqueuedAt: now },
	);
	// (e) Resume moved only its first batch; rule (a) enqueues these next run.
	const resumed = await pausedOf("active", {
		status: "pending",
		enqueuedAt: null,
	});
	report.resumed_paused = resumed.length;
	budget -= resumed.length;
	// (e′) destination disabled while deliveries were paused.
	const failed = await pausedOf("disabled", {
		status: "failed_final",
		lastError: "destination_disabled",
		completedAt: now,
	});
	report.failed_paused = failed.length;
	return report;
}
