import { getTableColumns, sql } from "drizzle-orm";
import type { Db } from "../../deps";
import { TERMINAL } from "./deliveries";
import { type DeliveryRow, deliveries } from "./schema";

export function insertReplayIfIdleStmt(db: Db, row: DeliveryRow) {
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
