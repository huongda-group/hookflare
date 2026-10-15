import { and, asc, eq, getTableColumns, inArray } from "drizzle-orm";
import type { Db, Deps } from "../../deps";
import {
	type DeliveryAttemptRow,
	type DeliveryRow,
	deliveries,
	deliveryAttempts,
	type WebhookEventRow,
	webhookEvents,
} from "./schema";

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

export type EventDetail = {
	event: Omit<WebhookEventRow, "bodyInline">;
	deliveries: (DeliveryRow & { attempts: DeliveryAttemptRow[] })[];
};

/** Never selects body_inline: payload viewing is an Operator permission in M3. */
export async function getEventDetail(
	db: Db,
	id: string,
): Promise<EventDetail | null> {
	const { bodyInline: _body, ...columns } = getTableColumns(webhookEvents);
	const event = await db
		.select(columns)
		.from(webhookEvents)
		.where(eq(webhookEvents.id, id))
		.get();
	if (!event) {
		return null;
	}
	const rows = await db
		.select()
		.from(deliveries)
		.where(eq(deliveries.eventId, id))
		.orderBy(asc(deliveries.createdAt), asc(deliveries.id))
		.all();
	const attempts = rows.length
		? await db
				.select()
				.from(deliveryAttempts)
				.where(
					inArray(
						deliveryAttempts.deliveryId,
						rows.map((r) => r.id),
					),
				)
				.orderBy(asc(deliveryAttempts.attemptNo))
				.all()
		: [];
	return {
		event,
		deliveries: rows.map((d) => ({
			...d,
			attempts: attempts.filter((a) => a.deliveryId === d.id),
		})),
	};
}
