import type { StorageSettings } from "@hookflare/shared";
import { and, eq, lt } from "drizzle-orm";
import { DAY_MS } from "../../core/db/archive";
import { archiveBatches } from "../../core/db/schema";
import type { Deps } from "../../deps";
import { batchPrefix, dayOf } from "./keys";

export const RETENTION_BATCHES_PER_RUN = 50;

/** Spec §7.4 `retention`. null archive_retention_days = keep forever. */
export async function expireArchives(
	deps: Deps,
	storage: StorageSettings,
	now: number,
): Promise<number> {
	if (storage.archive_retention_days === null) return 0;
	const before = dayOf(now - storage.archive_retention_days * DAY_MS);
	const due = await deps.db
		.select()
		.from(archiveBatches)
		.where(
			and(eq(archiveBatches.status, "purged"), lt(archiveBatches.day, before)),
		)
		.limit(RETENTION_BATCHES_PER_RUN);
	for (const b of due) {
		const prefix = batchPrefix(b.kind, b.day, b.id);
		let cursor: string | undefined;
		do {
			const page = await deps.payloads.list({ prefix, cursor });
			if (page.objects.length)
				await deps.payloads.delete(page.objects.map((o) => o.key));
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
		await deps.db
			.update(archiveBatches)
			.set({ status: "expired" })
			.where(
				and(eq(archiveBatches.id, b.id), eq(archiveBatches.status, "purged")),
			);
	}
	return due.length;
}
