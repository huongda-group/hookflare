import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "../../deps";
import { chunks } from "../enqueue";
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

/** Unexecuted conditional status change; returns no row when not in `from`. */
export function transitionDestinationStmt(
	db: Db,
	id: string,
	from: DestinationRow["status"],
	to: DestinationRow["status"],
	now: number,
) {
	return db
		.update(destinations)
		.set({ status: to, updatedAt: now })
		.where(and(eq(destinations.id, id), eq(destinations.status, from)))
		.returning();
}

/** Conditional status change; undefined when the row is not in `from`. */
export async function transitionDestination(
	db: Db,
	id: string,
	from: DestinationRow["status"],
	to: DestinationRow["status"],
	now: number,
): Promise<DestinationRow | undefined> {
	const [row] = await transitionDestinationStmt(db, id, from, to, now);
	return row;
}

export async function listDestinationStatuses(
	db: Db,
	ids: string[],
): Promise<Map<string, DestinationRow["status"]>> {
	const out = new Map<string, DestinationRow["status"]>();
	for (const chunk of chunks(ids)) {
		const rows = await db
			.select({ id: destinations.id, status: destinations.status })
			.from(destinations)
			.where(inArray(destinations.id, chunk))
			.all();
		for (const r of rows) out.set(r.id, r.status);
	}
	return out;
}
