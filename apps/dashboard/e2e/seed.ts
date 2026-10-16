import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");

/**
 * The SSRF guard blocks every local backend, so a delivery cannot really die
 * in E2E. Write a dead delivery straight into the local D1 (spec M4-13).
 *
 * Column names follow `apps/gateway/src/core/db/schema.ts` (snake_case):
 * `webhook_events.body_inline` holds the payload bytes, and `deliveries`
 * requires `project_id` and `created_at` (NOT NULL, no default).
 */
export function seedDeadDelivery(ids: {
	projectId: string;
	sourceId: string;
	destinationId: string;
}) {
	const now = Date.now();
	const suffix = now.toString(36);
	const eventId = `evt_e2e${suffix}`;
	const deliveryId = `dlv_e2e${suffix}`;
	const sql = [
		`INSERT INTO webhook_events (id, project_id, source_id, received_at, headers_json, content_type, size_bytes, payload_sha256, body_inline) VALUES ('${eventId}', '${ids.projectId}', '${ids.sourceId}', ${now}, '{}', 'application/json', 2, '${"0".repeat(64)}', X'7B7D');`,
		`INSERT INTO deliveries (id, event_id, destination_id, project_id, kind, status, attempt_count, created_at, completed_at, last_http_status, last_error) VALUES ('${deliveryId}', '${eventId}', '${ids.destinationId}', '${ids.projectId}', 'initial', 'dead', 3, ${now}, ${now}, 503, 'HTTP 503');`,
	].join(" ");
	execFileSync(
		"pnpm",
		[
			"exec",
			"wrangler",
			"d1",
			"execute",
			"DB",
			"--local",
			"--config",
			"apps/gateway/wrangler.jsonc",
			"--persist-to",
			".wrangler/e2e",
			"--command",
			sql,
		],
		{ cwd: ROOT, stdio: "pipe" },
	);
	return { eventId, deliveryId };
}
