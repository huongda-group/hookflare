import type { TestDelivery } from "@hookflare/shared";
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { Db } from "../../deps";
import { type TestDeliveryRow, testDeliveries } from "./schema";

/** Newest first, keyset on (started_at, id); returns up to limit + 1 rows. */
export async function listTestDeliveries(
	db: Db,
	destinationId: string,
	opts: { after?: { at: number; id: string }; limit: number },
): Promise<TestDeliveryRow[]> {
	const t = testDeliveries;
	return db
		.select()
		.from(t)
		.where(
			and(
				eq(t.destinationId, destinationId),
				opts.after
					? or(
							lt(t.startedAt, opts.after.at),
							and(eq(t.startedAt, opts.after.at), lt(t.id, opts.after.id)),
						)
					: undefined,
			),
		)
		.orderBy(desc(t.startedAt), desc(t.id))
		.limit(opts.limit + 1)
		.all();
}

export function toTestDelivery(r: TestDeliveryRow): TestDelivery {
	return {
		id: r.id,
		destination_id: r.destinationId,
		actor_email: r.actorEmail,
		started_at: r.startedAt,
		duration_ms: r.durationMs,
		http_status: r.httpStatus,
		error_kind: r.errorKind,
		error_message: r.errorMessage,
		response_snippet: r.responseSnippet,
	};
}
