import { and, eq } from "drizzle-orm";
import type { Deps } from "../../deps";
import { deliveries, webhookEvents } from "./schema";

export type NewEvent = {
	event: typeof webhookEvents.$inferInsert;
	delivery: typeof deliveries.$inferInsert;
};

/** Event and its initial delivery commit together or not at all. */
export async function insertEventWithDelivery(
	deps: Deps,
	input: NewEvent,
): Promise<void> {
	await deps.db.batch([
		deps.db.insert(webhookEvents).values(input.event),
		deps.db.insert(deliveries).values(input.delivery),
	]);
}

export async function markQueued(
	deps: Deps,
	deliveryId: string,
): Promise<void> {
	await deps.db
		.update(deliveries)
		.set({ status: "queued", enqueuedAt: deps.now() })
		.where(
			and(eq(deliveries.id, deliveryId), eq(deliveries.status, "pending")),
		);
}
