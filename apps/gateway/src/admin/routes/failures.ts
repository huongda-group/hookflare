import { type Failure, failuresQuery } from "@hookflare/shared";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { latestReplays, listFailures } from "../../core/db/deliveries";
import { requirePermission } from "../auth/permission";
import { decodeCursor, encodeCursor } from "../cursor";
import { toDelivery } from "../dto";
import { badCursor, readQuery } from "../http";

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

	return routes;
}
