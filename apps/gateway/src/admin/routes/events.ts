import { type EventSummary, eventSearchQuery } from "@hookflare/shared";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import {
	getEventDetail,
	latestDeliveries,
	listEventDeliveries,
	searchEvents,
} from "../../core/db/events";
import { requirePermission } from "../auth/permission";
import { decodeCursor, encodeCursor } from "../cursor";
import { toAttempt, toDelivery } from "../dto";
import { badCursor, readQuery } from "../http";

export function eventRoutes() {
	const routes = new Hono<AppBindings>();

	routes.get("/", requirePermission("events.read"), async (c) => {
		const q = readQuery(c, eventSearchQuery, ["status"]);
		if (!q.ok) return q.response;
		const after = decodeCursor(q.value.cursor);
		if (after === "invalid") return badCursor(c);
		const { db } = c.var.deps;
		const rows = await searchEvents(db, {
			projectId: q.value.project_id,
			sourceId: q.value.source_id,
			destinationId: q.value.destination_id,
			statuses: q.value.status,
			providerEventId: q.value.provider_event_id,
			from: q.value.from,
			to: q.value.to,
			after: after ?? undefined,
			limit: q.value.limit,
		});
		const page = rows.slice(0, q.value.limit);
		const latest = await latestDeliveries(
			db,
			page.map((e) => e.id),
		);
		const last = page.at(-1);
		return c.json({
			data: page.map((e): EventSummary => {
				const d = latest.get(e.id);
				return {
					id: e.id,
					project_id: e.projectId,
					source_id: e.sourceId,
					provider_event_id: e.providerEventId,
					received_at: e.receivedAt,
					content_type: e.contentType,
					size_bytes: e.sizeBytes,
					latest_delivery: d
						? {
								id: d.id,
								kind: d.kind,
								status: d.status,
								attempt_count: d.attemptCount,
							}
						: null,
				};
			}),
			next_cursor:
				rows.length > q.value.limit && last
					? encodeCursor(last.receivedAt, last.id)
					: null,
		});
	});

	routes.get("/:id/deliveries", requirePermission("events.read"), async (c) => {
		const { db } = c.var.deps;
		const id = c.req.param("id");
		const rows = await listEventDeliveries(db, id);
		if (rows.length === 0 && !(await getEventDetail(db, id))) {
			return c.json({ error: "not_found" }, 404);
		}
		return c.json({ data: rows.map(toDelivery), next_cursor: null });
	});

	routes.get("/:id", requirePermission("events.read"), async (c) => {
		const detail = await getEventDetail(c.var.deps.db, c.req.param("id"));
		if (!detail) return c.json({ error: "not_found" }, 404);
		const { event, deliveries } = detail;
		return c.json({
			id: event.id,
			project_id: event.projectId,
			source_id: event.sourceId,
			provider_event_id: event.providerEventId,
			received_at: event.receivedAt,
			headers: event.headersJson,
			content_type: event.contentType,
			size_bytes: event.sizeBytes,
			payload_sha256: event.payloadSha256,
			deliveries: deliveries.map((d) => ({
				...toDelivery(d),
				attempts: d.attempts.map(toAttempt),
			})),
		});
	});

	return routes;
}
