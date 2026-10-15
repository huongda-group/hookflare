import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "../../deps";
import { type DestinationRow, destinations } from "./schema";

export async function getDestination(
	db: Db,
	id: string,
): Promise<DestinationRow | undefined> {
	return db.select().from(destinations).where(eq(destinations.id, id)).get();
}

export async function listDestinations(
	db: Db,
	q: { limit: number; cursor?: string; projectId?: string },
): Promise<DestinationRow[]> {
	return db
		.select()
		.from(destinations)
		.where(
			and(
				q.cursor ? lt(destinations.id, q.cursor) : undefined,
				q.projectId ? eq(destinations.projectId, q.projectId) : undefined,
			),
		)
		.orderBy(desc(destinations.id))
		.limit(q.limit + 1)
		.all();
}

/** Conditional status change; undefined when the row is not in `from`. */
export async function transitionDestination(
	db: Db,
	id: string,
	from: DestinationRow["status"],
	to: DestinationRow["status"],
	now: number,
): Promise<DestinationRow | undefined> {
	const [row] = await db
		.update(destinations)
		.set({ status: to, updatedAt: now })
		.where(and(eq(destinations.id, id), eq(destinations.status, from)))
		.returning();
	return row;
}
