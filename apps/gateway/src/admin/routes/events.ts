import {
	type EventSummary,
	eventSearchQuery,
	type ReplayResult,
	replayRequest,
} from "@hookflare/shared";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { getInitialDelivery } from "../../core/db/deliveries";
import {
	getEventDetail,
	getEventPayloadRef,
	latestDeliveries,
	searchEvents,
} from "../../core/db/events";
import { loadPayload } from "../../core/payloads";
import { requirePermission } from "../auth/permission";
import { decodeCursor, encodeCursor } from "../cursor";
import { toAttempt, toDelivery } from "../dto";
import { auditStmt, badCursor, readJson, readQuery } from "../http";
import { precheck, writeReplays } from "../replay";

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
		const detail = await getEventDetail(c.var.deps.db, c.req.param("id"));
		if (!detail) return c.json({ error: "not_found" }, 404);
		return c.json({
			data: detail.deliveries.map((d) => ({
				...toDelivery(d),
				attempts: d.attempts.map(toAttempt),
			})),
			next_cursor: null,
		});
	});

	routes.get("/:id/payload", requirePermission("payload.read"), async (c) => {
		const deps = c.var.deps;
		const ref = await getEventPayloadRef(deps.db, c.req.param("id"));
		if (!ref) return c.json({ error: "not_found" }, 404);
		let body: Uint8Array | null;
		try {
			body = await loadPayload(deps, ref);
		} catch (err) {
			c.var.logger.error("admin.payload_load_failed", {
				event_id: ref.id,
				error: String(err),
			});
			return c.json({ error: "unavailable" }, 503);
		}
		if (body === null) return c.json({ error: "payload_missing" }, 404);
		// Spec §8.3: no audit row, no payload.
		try {
			await auditStmt(c, {
				action: "event.payload_viewed",
				resourceType: "event",
				resourceId: ref.id,
			});
		} catch (err) {
			c.var.logger.error("admin.audit_failed", {
				event_id: ref.id,
				error: String(err),
			});
			return c.json({ error: "unavailable" }, 503);
		}
		return new Response(body, {
			headers: {
				"content-type": ref.contentType ?? "application/octet-stream",
				"content-disposition": `attachment; filename="${ref.id}"`,
				"x-content-type-options": "nosniff",
				"cache-control": "no-store",
			},
		});
	});

	routes.post(
		"/:id/replay",
		requirePermission("deliveries.replay"),
		async (c) => {
			const body = await readJson(c, replayRequest);
			if (!body.ok) return body.response;
			const deps = c.var.deps;
			const eventId = c.req.param("id");
			const initial = await getInitialDelivery(deps.db, eventId);
			if (!initial) return c.json({ error: "not_found" }, 404);
			let checked: Awaited<ReturnType<typeof precheck>>;
			try {
				checked = await precheck(deps, [
					{
						sourceDeliveryId: initial.id,
						eventId,
						destinationId: initial.destinationId,
						projectId: initial.projectId,
					},
				]);
			} catch (err) {
				c.var.logger.error("admin.replay_precheck_failed", {
					error: String(err),
				});
				return c.json({ error: "unavailable" }, 503);
			}
			const [skip] = checked.skipped;
			if (skip) return c.json({ error: skip.reason }, 409);
			const [r] = await writeReplays(c, {
				...checked,
				reason: body.value.reason,
				resourceType: "event",
				resourceId: eventId,
			});
			return c.json(
				{
					delivery_id: r.new_delivery_id,
					status: r.status,
					enqueued: r.enqueued,
				} satisfies ReplayResult,
				201,
			);
		},
	);

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
