import {
	type ArchiveBatch,
	archivePreviewQuery,
	archivesQuery,
} from "@hookflare/shared";
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	lt,
	lte,
	or,
	type SQL,
} from "drizzle-orm";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { startArchiveRun } from "../../core/archive-run";
import { countEligible, cutoffsFor } from "../../core/db/archive";
import { archiveBatches, archiveParts } from "../../core/db/schema";
import { newId } from "../../core/ids";
import { readSetting, STORAGE_SETTING } from "../../core/settings";
import { requirePermission } from "../auth/permission";
import { decodeCursor, encodeCursor } from "../cursor";
import { auditStmt, badCursor, readQuery } from "../http";

type BatchRow = typeof archiveBatches.$inferSelect;
type PartRow = typeof archiveParts.$inferSelect;

const DOWNLOADABLE = new Set(["verified", "purged"]);

function toBatch(b: BatchRow, parts: PartRow[]): ArchiveBatch {
	const downloadable = b.withFiles && DOWNLOADABLE.has(b.status);
	return {
		id: b.id,
		kind: b.kind,
		day: b.day,
		status: b.status,
		with_files: b.withFiles,
		part_count: b.partCount,
		item_count: b.itemCount,
		bytes: b.bytes,
		workflow_instance_id: b.workflowInstanceId,
		error: b.error,
		created_at: b.createdAt,
		verified_at: b.verifiedAt,
		purged_at: b.purgedAt,
		parts: parts.map((p) => ({
			part_no: p.partNo,
			item_count: p.itemCount,
			bytes: p.bytes,
			sha256: p.sha256,
			first_id: p.firstId,
			last_id: p.lastId,
			downloadable: downloadable && p.r2Key !== null,
		})),
	};
}

export function archiveRoutes() {
	const routes = new Hono<AppBindings>();

	routes.get("/", requirePermission("events.read"), async (c) => {
		const q = readQuery(c, archivesQuery);
		if (!q.ok) return q.response;
		const { kind, status, from_day, to_day, limit, cursor } = q.value;
		const where: SQL[] = [];
		if (kind) where.push(eq(archiveBatches.kind, kind));
		if (status) where.push(eq(archiveBatches.status, status));
		if (from_day) where.push(gte(archiveBatches.day, from_day));
		if (to_day) where.push(lte(archiveBatches.day, to_day));
		if (cursor) {
			const cur = decodeCursor(cursor);
			if (cur === "invalid" || cur === null) return badCursor(c);
			where.push(
				or(
					lt(archiveBatches.createdAt, cur.at),
					and(
						eq(archiveBatches.createdAt, cur.at),
						lt(archiveBatches.id, cur.id),
					),
				) as SQL,
			);
		}
		const { db } = c.var.deps;
		const rows = await db
			.select()
			.from(archiveBatches)
			.where(and(...where))
			.orderBy(desc(archiveBatches.createdAt), desc(archiveBatches.id))
			.limit(limit + 1);
		const page = rows.slice(0, limit);
		// limit ≤ 50 keeps this IN list under D1's 100-parameter cap.
		const parts = page.length
			? await db
					.select()
					.from(archiveParts)
					.where(
						inArray(
							archiveParts.batchId,
							page.map((b) => b.id),
						),
					)
					.orderBy(archiveParts.partNo)
			: [];
		const last = page.at(-1);
		return c.json({
			data: page.map((b) =>
				toBatch(
					b,
					parts.filter((p) => p.batchId === b.id),
				),
			),
			next_cursor:
				rows.length > limit && last
					? encodeCursor(last.createdAt, last.id)
					: null,
		});
	});

	routes.get("/preview", requirePermission("settings.manage"), async (c) => {
		const q = readQuery(c, archivePreviewQuery);
		if (!q.ok) return q.response;
		const { db, now } = c.var.deps;
		const t = now();
		const current = (await readSetting(db, STORAGE_SETTING)).value;
		const [eligible, currently] = await Promise.all([
			countEligible(db, cutoffsFor(q.value, t)),
			countEligible(db, cutoffsFor(current, t)),
		]);
		return c.json({ eligible, currently_eligible: currently });
	});

	routes.post("/run", requirePermission("settings.manage"), async (c) => {
		const deps = c.var.deps;
		const instanceId = `archive-manual-${newId("arb").slice(4).toLowerCase()}`;
		await startArchiveRun(deps, instanceId, "manual", c.var.logger);
		await deps.db.batch([
			auditStmt(c, {
				action: "archive.run_started",
				resourceType: "archive_run",
				resourceId: instanceId,
			}),
		]);
		return c.json({ instance_id: instanceId }, 202);
	});

	routes.get(
		"/:batchId/parts/:n",
		requirePermission("payload.read"),
		async (c) => {
			const { db, payloads } = c.var.deps;
			const batchId = c.req.param("batchId");
			const n = Number(c.req.param("n"));
			const batch = await db
				.select()
				.from(archiveBatches)
				.where(eq(archiveBatches.id, batchId))
				.get();
			if (
				!batch ||
				!Number.isInteger(n) ||
				!batch.withFiles ||
				!DOWNLOADABLE.has(batch.status)
			) {
				return c.json({ error: "not_found" }, 404);
			}
			const part = await db
				.select()
				.from(archiveParts)
				.where(
					and(eq(archiveParts.batchId, batchId), eq(archiveParts.partNo, n)),
				)
				.get();
			const obj = part?.r2Key ? await payloads.get(part.r2Key) : null;
			if (!obj) return c.json({ error: "not_found" }, 404);
			await db.batch([
				auditStmt(c, {
					action: "archive.downloaded",
					resourceType: "archive_batch",
					resourceId: batchId,
					diff: { part_no: n },
				}),
			]);
			const filename = `hookflare-${batch.kind}-${batch.day}-${batchId}-part-${String(n).padStart(4, "0")}.ndjson.gz`;
			return new Response(obj.body, {
				headers: {
					"content-type": "application/gzip",
					"content-disposition": `attachment; filename="${filename}"`,
					"content-length": String(obj.size),
				},
			});
		},
	);

	return routes;
}
