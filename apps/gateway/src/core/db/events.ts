import type { SQL } from "drizzle-orm";
import {
	and,
	asc,
	desc,
	eq,
	exists,
	getTableColumns,
	gte,
	inArray,
	lt,
	lte,
	or,
	sql,
} from "drizzle-orm";
import type { Db, Deps } from "../../deps";
import { chunks } from "../enqueue";
import {
	type DeliveryAttemptRow,
	type DeliveryRow,
	type DeliveryStatus,
	deliveries,
	deliveryAttempts,
	type WebhookEventRow,
	webhookEvents,
} from "./schema";

export type NewEvent = {
	event: typeof webhookEvents.$inferInsert;
	delivery: typeof deliveries.$inferInsert;
};

/** Event and its initial delivery commit together or not at all. A duplicate
 * provider event id makes the event insert a no-op, so the delivery insert
 * fails its FK and the batch rolls back (spec §6.1). */
export async function insertEventWithDelivery(
	deps: Deps,
	input: NewEvent,
): Promise<void> {
	await deps.db.batch([
		deps.db.insert(webhookEvents).values(input.event).onConflictDoNothing(),
		deps.db.insert(deliveries).values(input.delivery),
	]);
}

export async function findEventIdByProviderId(
	db: Db,
	sourceId: string,
	providerEventId: string,
): Promise<string | null> {
	const row = await db
		.select({ id: webhookEvents.id })
		.from(webhookEvents)
		.where(
			and(
				eq(webhookEvents.sourceId, sourceId),
				eq(webhookEvents.providerEventId, providerEventId),
			),
		)
		.get();
	return row?.id ?? null;
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

export type EventFilter = {
	projectId?: string;
	sourceId?: string;
	destinationId?: string;
	statuses?: DeliveryStatus[];
	providerEventId?: string;
	from?: number;
	to?: number;
	after?: { at: number; id: string };
	limit: number;
};

/**
 * Spec §8.2. Event columns only; delivery filters are EXISTS subqueries so
 * an event with several matching deliveries appears once. Returns limit + 1
 * rows so the caller can tell whether a next page exists.
 */
export async function searchEvents(db: Db, f: EventFilter) {
	const where: (SQL | undefined)[] = [
		f.projectId ? eq(webhookEvents.projectId, f.projectId) : undefined,
		f.sourceId ? eq(webhookEvents.sourceId, f.sourceId) : undefined,
		f.providerEventId
			? eq(webhookEvents.providerEventId, f.providerEventId)
			: undefined,
		f.from !== undefined ? gte(webhookEvents.receivedAt, f.from) : undefined,
		f.to !== undefined ? lte(webhookEvents.receivedAt, f.to) : undefined,
		f.after
			? or(
					lt(webhookEvents.receivedAt, f.after.at),
					and(
						eq(webhookEvents.receivedAt, f.after.at),
						lt(webhookEvents.id, f.after.id),
					),
				)
			: undefined,
	];
	if (f.destinationId || f.statuses?.length) {
		where.push(
			exists(
				db
					.select({ one: sql`1` })
					.from(deliveries)
					.where(
						and(
							eq(deliveries.eventId, webhookEvents.id),
							f.destinationId
								? eq(deliveries.destinationId, f.destinationId)
								: undefined,
							f.statuses?.length
								? inArray(deliveries.status, f.statuses)
								: undefined,
						),
					),
			),
		);
	}
	const {
		bodyInline: _body,
		headersJson: _headers,
		...columns
	} = getTableColumns(webhookEvents);
	return db
		.select(columns)
		.from(webhookEvents)
		.where(and(...where))
		.orderBy(desc(webhookEvents.receivedAt), desc(webhookEvents.id))
		.limit(f.limit + 1)
		.all();
}

/** The highest-id (newest) delivery of each event (spec §8.2). */
export async function latestDeliveries(
	db: Db,
	eventIds: string[],
): Promise<Map<string, DeliveryRow>> {
	const out = new Map<string, DeliveryRow>();
	for (const chunk of chunks(eventIds)) {
		const rows = await db
			.select()
			.from(deliveries)
			.where(inArray(deliveries.eventId, chunk))
			.orderBy(asc(deliveries.id))
			.all();
		for (const row of rows) out.set(row.eventId, row); // ascending: last wins
	}
	return out;
}

export async function listEventDeliveries(
	db: Db,
	eventId: string,
): Promise<DeliveryRow[]> {
	return db
		.select()
		.from(deliveries)
		.where(eq(deliveries.eventId, eventId))
		.orderBy(asc(deliveries.createdAt), asc(deliveries.id))
		.all();
}

/** The only reader of event bodies on the admin side (spec §8.3). */
export async function getEventPayloadRef(db: Db, id: string) {
	return db
		.select({
			id: webhookEvents.id,
			contentType: webhookEvents.contentType,
			r2Key: webhookEvents.r2Key,
			bodyInline: webhookEvents.bodyInline,
		})
		.from(webhookEvents)
		.where(eq(webhookEvents.id, id))
		.get();
}
