import { and, eq, inArray, sql } from "drizzle-orm";
import type { Outcome } from "../../delivery/classify";
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

const CLAIMABLE = ["pending", "queued"] as const;

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
	await deps.db
		.update(deliveries)
		.set({ status: "failed_final", lastError, completedAt: deps.now() })
		.where(
			and(eq(deliveries.id, deliveryId), inArray(deliveries.status, CLAIMABLE)),
		);
}

/** true when this consumer won the delivery. M2 replaces this with a lease. */
export async function claimDelivery(
	deps: Deps,
	deliveryId: string,
): Promise<boolean> {
	const result = await deps.db
		.update(deliveries)
		.set({ status: "in_flight" })
		.where(
			and(eq(deliveries.id, deliveryId), inArray(deliveries.status, CLAIMABLE)),
		);
	return result.meta.changes === 1;
}

export async function recordAttempt(
	deps: Deps,
	ctx: DeliveryContext,
	a: {
		startedAt: number;
		durationMs: number;
		outcome: Outcome;
		snippet: string | null;
	},
): Promise<void> {
	const attemptNo = ctx.delivery.attemptCount + 1;
	await deps.db.batch([
		deps.db.insert(deliveryAttempts).values({
			id: newId("att", a.startedAt),
			deliveryId: ctx.delivery.id,
			attemptNo,
			startedAt: a.startedAt,
			durationMs: a.durationMs,
			httpStatus: a.outcome.httpStatus,
			errorKind: a.outcome.errorKind,
			errorMessage: a.outcome.error,
			responseSnippet: a.snippet,
		}),
		deps.db
			.update(deliveries)
			.set({
				attemptCount: sql`${deliveries.attemptCount} + 1`,
				status: a.outcome.status,
				lastHttpStatus: a.outcome.httpStatus,
				lastError: a.outcome.error,
				completedAt: deps.now(),
			})
			.where(eq(deliveries.id, ctx.delivery.id)),
	]);
}
