import type { Delivery, DeliveryAttempt } from "@hookflare/shared";
import type { DeliveryAttemptRow, DeliveryRow } from "../core/db/schema";

export function toDelivery(d: DeliveryRow): Omit<Delivery, "attempts"> {
	return {
		id: d.id,
		destination_id: d.destinationId,
		kind: d.kind,
		status: d.status,
		attempt_count: d.attemptCount,
		enqueued_at: d.enqueuedAt,
		next_attempt_at: d.nextAttemptAt,
		last_http_status: d.lastHttpStatus,
		last_error: d.lastError,
		completed_at: d.completedAt,
		created_at: d.createdAt,
	};
}

export function toAttempt(a: DeliveryAttemptRow): DeliveryAttempt {
	return {
		id: a.id,
		attempt_no: a.attemptNo,
		started_at: a.startedAt,
		duration_ms: a.durationMs,
		http_status: a.httpStatus,
		error_kind: a.errorKind,
		error_message: a.errorMessage,
		response_snippet: a.responseSnippet,
	};
}
