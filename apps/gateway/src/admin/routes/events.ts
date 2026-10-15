import type { WebhookEvent } from "@hookflare/shared";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { getEventDetail } from "../../core/db/events";

export function eventRoutes() {
	const routes = new Hono<AppBindings>();

	routes.get("/:id", async (c) => {
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
				id: d.id,
				destination_id: d.destinationId,
				kind: d.kind,
				status: d.status,
				attempt_count: d.attemptCount,
				enqueued_at: d.enqueuedAt,
				last_http_status: d.lastHttpStatus,
				last_error: d.lastError,
				completed_at: d.completedAt,
				created_at: d.createdAt,
				attempts: d.attempts.map((a) => ({
					id: a.id,
					attempt_no: a.attemptNo,
					started_at: a.startedAt,
					duration_ms: a.durationMs,
					http_status: a.httpStatus,
					error_kind: a.errorKind,
					error_message: a.errorMessage,
					response_snippet: a.responseSnippet,
				})),
			})),
		} satisfies WebhookEvent);
	});

	return routes;
}
