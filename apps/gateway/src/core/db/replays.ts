import { getTableColumns, sql } from "drizzle-orm";
import type { Db } from "../../deps";
import { TERMINAL } from "./deliveries";
import { type DeliveryRow, deliveries } from "./schema";

/**
 * Unexecuted conditional insert of one replay delivery: it inserts only while
 * no non-terminal replay of the same event and destination exists, checked
 * inside the statement, so two concurrent replays that both passed precheck
 * create one row. `.returning()` yields the row only when it was inserted.
 */
export function insertReplayIfIdleStmt(db: Db, row: DeliveryRow) {
	// `insert().select()` requires every column, in declaration order.
	const fields = Object.fromEntries(
		Object.entries(getTableColumns(deliveries)).map(([key, column]) => [
			key,
			sql`${row[key as keyof DeliveryRow]}`.as(column.name),
		]),
	) as Record<keyof DeliveryRow, ReturnType<ReturnType<typeof sql>["as"]>>;
	const terminal = sql.join(
		TERMINAL.map((s) => sql`${s}`),
		sql`, `,
	);
	return db
		.insert(deliveries)
		.select(
			db
				.select(fields)
				.from(sql`(SELECT 1)`)
				.where(
					sql`NOT EXISTS (SELECT 1 FROM deliveries WHERE event_id = ${row.eventId} AND destination_id = ${row.destinationId} AND kind = 'replay' AND status NOT IN (${terminal}))`,
				),
		)
		.returning({ id: deliveries.id });
}
