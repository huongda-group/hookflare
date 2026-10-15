import {
	type BulkReplayResult,
	bulkReplayRequest,
	type Failure,
	failuresQuery,
} from "@hookflare/shared";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import {
	getDeliveriesByIds,
	latestReplays,
	listFailures,
} from "../../core/db/deliveries";
import { requirePermission } from "../auth/permission";
import { decodeCursor, encodeCursor } from "../cursor";
import { toDelivery } from "../dto";
import { badCursor, readJson, readQuery } from "../http";
import {
	precheck,
	type ReplayTarget,
	type Skip,
	writeReplays,
} from "../replay";

export function failureRoutes() {
	const routes = new Hono<AppBindings>();

	routes.get("/", requirePermission("events.read"), async (c) => {
		const q = readQuery(c, failuresQuery, ["status"]);
		if (!q.ok) return q.response;
		const after = decodeCursor(q.value.cursor);
		if (after === "invalid") return badCursor(c);
		const { db } = c.var.deps;
		const rows = await listFailures(db, {
			statuses: q.value.status,
			projectId: q.value.project_id,
			destinationId: q.value.destination_id,
			from: q.value.from,
			to: q.value.to,
			unresolved: q.value.unresolved,
			after: after ?? undefined,
			limit: q.value.limit,
		});
		const page = rows.slice(0, q.value.limit);
		const replays = await latestReplays(db, page);
		const last = page.at(-1);
		return c.json({
			data: page.map((d): Failure => {
				const r = replays.get(`${d.eventId}|${d.destinationId}`);
				return {
					...toDelivery(d),
					event_id: d.eventId,
					project_id: d.projectId,
					source_id: d.sourceId,
					received_at: d.receivedAt,
					latest_replay:
						r && r.id > d.id ? { id: r.id, status: r.status } : null,
				};
			}),
			next_cursor:
				rows.length > q.value.limit && last
					? encodeCursor(last.completedAt ?? 0, last.id)
					: null,
		});
	});

	routes.post("/replay", requirePermission("deliveries.replay"), async (c) => {
		const body = await readJson(c, bulkReplayRequest);
		if (!body.ok) return body.response;
		const deps = c.var.deps;
		const ids = body.value.delivery_ids;
		const found = new Map(
			(await getDeliveriesByIds(deps.db, ids)).map((d) => [d.id, d]),
		);
		const skipped: Skip[] = [];
		const targets: ReplayTarget[] = [];
		for (const id of ids) {
			const d = found.get(id);
			if (!d) skipped.push({ delivery_id: id, reason: "not_found" });
			else if (d.status !== "failed_final" && d.status !== "dead")
				skipped.push({ delivery_id: id, reason: "not_failed" });
			else
				targets.push({
					sourceDeliveryId: d.id,
					eventId: d.eventId,
					destinationId: d.destinationId,
					projectId: d.projectId,
				});
		}
		let checked: Awaited<ReturnType<typeof precheck>>;
		try {
			checked = await precheck(deps, targets);
		} catch (err) {
			c.var.logger.error("admin.replay_precheck_failed", {
				error: String(err),
			});
			return c.json({ error: "unavailable" }, 503);
		}
		const allSkipped = [...skipped, ...checked.skipped];
		const replayed = await writeReplays(c, {
			ready: checked.ready,
			skipped: allSkipped,
			reason: body.value.reason,
			resourceType: "delivery",
			resourceId: null,
		});
		return c.json({
			replayed: replayed.map((r) => ({
				delivery_id: r.source_delivery_id,
				new_delivery_id: r.new_delivery_id,
				enqueued: r.enqueued,
			})),
			skipped: allSkipped,
		} satisfies BulkReplayResult);
	});

	return routes;
}
