import type { StorageSettings } from "@hookflare/shared";
import { and, eq, lt } from "drizzle-orm";
import { DAY_MS } from "../../core/db/archive";
import { archiveBatches } from "../../core/db/schema";
import type { Deps } from "../../deps";
import { batchPrefix } from "./keys";

export const RETENTION_BATCHES_PER_RUN = 50;

type Batch = typeof archiveBatches.$inferSelect;

async function deletePrefix(deps: Deps, b: Batch): Promise<void> {
	const prefix = batchPrefix(b.kind, b.day, b.id);
	let cursor: string | undefined;
	do {
		const page = await deps.payloads.list({ prefix, cursor });
		if (page.objects.length)
			await deps.payloads.delete(page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

export async function expireArchives(
	deps: Deps,
	storage: StorageSettings,
	now: number,
): Promise<number> {
	const failed = await deps.db
		.select()
		.from(archiveBatches)
		.where(
			and(
				eq(archiveBatches.status, "failed"),
				eq(archiveBatches.withFiles, true),
			),
		)
		.limit(RETENTION_BATCHES_PER_RUN);
	for (const b of failed) {
		await deletePrefix(deps, b);
		await deps.db
			.update(archiveBatches)
			.set({ withFiles: false })
			.where(
				and(eq(archiveBatches.id, b.id), eq(archiveBatches.status, "failed")),
			);
	}

	if (storage.archive_retention_days === null) return 0;
	const due = await deps.db
		.select()
		.from(archiveBatches)
		.where(
			and(
				eq(archiveBatches.status, "purged"),
				lt(
					archiveBatches.purgedAt,
					now - storage.archive_retention_days * DAY_MS,
				),
			),
		)
		.limit(RETENTION_BATCHES_PER_RUN);
	for (const b of due) {
		await deletePrefix(deps, b);
		await deps.db
			.update(archiveBatches)
			.set({ status: "expired" })
			.where(
				and(eq(archiveBatches.id, b.id), eq(archiveBatches.status, "purged")),
			);
	}
	return due.length;
}
