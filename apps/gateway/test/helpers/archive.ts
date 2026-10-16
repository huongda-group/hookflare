import { sql } from "drizzle-orm";
import { archiveBatches, archiveParts } from "../../src/core/db/schema";
import { newId } from "../../src/core/ids";
import type { Deps } from "../../src/deps";

/** Archive tests own every event older than a year in the shared D1. */
export async function isolateArchive(deps: Deps) {
	await deps.db.delete(archiveParts);
	await deps.db.delete(archiveBatches);
	await deps.db.run(
		sql`UPDATE webhook_events SET archive_batch_id = 'foreign' WHERE archive_batch_id IS NULL`,
	);
}

export async function seedBatch(
	deps: Deps,
	o: Partial<typeof archiveBatches.$inferInsert> = {},
) {
	const row = {
		id: newId("arb"),
		kind: "events" as const,
		day: "2026-01-02",
		status: "building" as const,
		withFiles: true,
		workflowInstanceId: "test-instance",
		createdAt: Date.now(),
		...o,
	};
	await deps.db.insert(archiveBatches).values(row);
	return row;
}

export async function listKeys(
	bucket: R2Bucket,
	prefix: string,
): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor });
		keys.push(...page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return keys;
}
