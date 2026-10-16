import { sql } from "drizzle-orm";
import {
	check,
	customType,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const PROJECT_STATUSES = ["active", "disabled"] as const;
export const DESTINATION_STATUSES = ["active", "paused", "disabled"] as const;
export const SOURCE_STATUSES = ["active", "disabled"] as const;
export const AUTH_TYPES = ["none", "hmac", "token"] as const;
export const EVENT_ID_FROM = ["none", "header", "json_path"] as const;
export const DELIVERY_KINDS = ["initial", "replay", "test"] as const;
// The full roadmap §6 state machine, although M1 only writes some of them:
// changing a CHECK constraint in SQLite requires rebuilding the table.
export const DELIVERY_STATUSES = [
	"pending",
	"queued",
	"in_flight",
	"retrying",
	"paused",
	"delivered",
	"failed_final",
	"dead",
] as const;
export const ERROR_KINDS = [
	"http_3xx",
	"http_4xx",
	"http_5xx",
	"timeout",
	"network",
] as const;

export const ROLES = ["admin", "operator", "viewer"] as const;
/** Test deliveries also record an SSRF block, which never reaches the backend. */
export const TEST_ERROR_KINDS = [...ERROR_KINDS, "ssrf_blocked"] as const;

export type AuthType = (typeof AUTH_TYPES)[number];
export type EventIdFrom = (typeof EVENT_ID_FROM)[number];
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type ErrorKind = (typeof ERROR_KINDS)[number];
export type Role = (typeof ROLES)[number];
export type TestErrorKind = (typeof TEST_ERROR_KINDS)[number];

/** `"<column>" IN ('a', 'b')` from a constant list (never user input). */
function inList(column: string, values: readonly string[]) {
	return sql.raw(`"${column}" IN (${values.map((v) => `'${v}'`).join(", ")})`);
}

/** BLOB as Uint8Array. D1 may return BLOBs as ArrayBuffer or number[]. */
const bytes = customType<{
	data: Uint8Array;
	driverData: ArrayBuffer | Uint8Array | number[];
}>({
	dataType: () => "blob",
	toDriver: (value) => value,
	fromDriver: (value) => {
		if (value instanceof Uint8Array) {
			return value;
		}
		return Array.isArray(value)
			? Uint8Array.from(value)
			: new Uint8Array(value);
	},
});

/** M0 table (0001_settings.sql, STRICT). Declared so drizzle-kit never recreates it. */
export const settings = sqliteTable("settings", {
	key: text("key").primaryKey(),
	valueJson: text("value_json").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export const projects = sqliteTable(
	"projects",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		slug: text("slug").notNull().unique(),
		status: text("status", { enum: PROJECT_STATUSES })
			.notNull()
			.default("active"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	() => [check("projects_status_check", inList("status", PROJECT_STATUSES))],
);

export const destinations = sqliteTable(
	"destinations",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id),
		name: text("name").notNull(),
		url: text("url").notNull(),
		status: text("status", { enum: DESTINATION_STATUSES })
			.notNull()
			.default("active"),
		signingSecretEnc: text("signing_secret_enc").notNull(),
		/** Previous secret during a rotation grace window (spec §11); both or neither set. */
		signingSecretPrevEnc: text("signing_secret_prev_enc"),
		signingSecretPrevExpiresAt: integer("signing_secret_prev_expires_at"),
		timeoutMs: integer("timeout_ms"),
		// NULL means the global default (core/policy.ts).
		maxAttempts: integer("max_attempts"),
		backoffBaseS: integer("backoff_base_s"),
		backoffMaxS: integer("backoff_max_s"),
		// M5a limits (spec §5.1). Bounds 1–1000 are enforced by the API only:
		// a table-level CHECK would make drizzle-kit rebuild this FK target.
		maxInFlight: integer("max_in_flight"),
		rateLimitPerS: integer("rate_limit_per_s"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	() => [
		check("destinations_status_check", inList("status", DESTINATION_STATUSES)),
	],
);

export const sources = sqliteTable(
	"sources",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id),
		destinationId: text("destination_id")
			.notNull()
			.references(() => destinations.id),
		name: text("name").notNull(),
		status: text("status", { enum: SOURCE_STATUSES })
			.notNull()
			.default("active"),
		authType: text("auth_type", { enum: AUTH_TYPES }).notNull(),
		authConfig: text("auth_config", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull(),
		secretEnc: text("secret_enc"),
		/** Previous secret during a rotation grace window (spec §11); both or neither set. */
		secretPrevEnc: text("secret_prev_enc"),
		secretPrevExpiresAt: integer("secret_prev_expires_at"),
		eventIdFrom: text("event_id_from", { enum: EVENT_ID_FROM })
			.notNull()
			.default("none"),
		eventIdSelector: text("event_id_selector"),
		maxBodyBytes: integer("max_body_bytes"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	() => [
		check("sources_status_check", inList("status", SOURCE_STATUSES)),
		check("sources_auth_type_check", inList("auth_type", AUTH_TYPES)),
		check(
			"sources_event_id_from_check",
			inList("event_id_from", EVENT_ID_FROM),
		),
		check(
			"sources_secret_check",
			sql.raw(`("auth_type" = 'none') = ("secret_enc" IS NULL)`),
		),
		check(
			"sources_event_id_check",
			sql.raw(`("event_id_from" = 'none') = ("event_id_selector" IS NULL)`),
		),
	],
);

export const webhookEvents = sqliteTable(
	"webhook_events",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id").notNull(),
		sourceId: text("source_id")
			.notNull()
			.references(() => sources.id),
		providerEventId: text("provider_event_id"),
		receivedAt: integer("received_at").notNull(),
		headersJson: text("headers_json", { mode: "json" })
			.$type<Record<string, string>>()
			.notNull(),
		contentType: text("content_type"),
		sizeBytes: integer("size_bytes").notNull(),
		payloadSha256: text("payload_sha256").notNull(),
		bodyInline: bytes("body_inline").notNull(),
		/** Set when the body is in R2 (> 64 KiB); body_inline is then empty. */
		r2Key: text("r2_key"),
	},
	(t) => [
		index("webhook_events_source_received_idx").on(t.sourceId, t.receivedAt),
		index("webhook_events_project_received_idx").on(t.projectId, t.receivedAt),
		index("webhook_events_received_idx").on(t.receivedAt),
		uniqueIndex("webhook_events_source_provider_uq")
			.on(t.sourceId, t.providerEventId)
			.where(sql`provider_event_id IS NOT NULL`),
	],
);

export const deliveries = sqliteTable(
	"deliveries",
	{
		id: text("id").primaryKey(),
		eventId: text("event_id")
			.notNull()
			.references(() => webhookEvents.id),
		destinationId: text("destination_id")
			.notNull()
			.references(() => destinations.id),
		projectId: text("project_id").notNull(),
		kind: text("kind", { enum: DELIVERY_KINDS }).notNull(),
		status: text("status", { enum: DELIVERY_STATUSES }).notNull(),
		attemptCount: integer("attempt_count").notNull().default(0),
		enqueuedAt: integer("enqueued_at"),
		/** Only while status = 'retrying'. */
		nextAttemptAt: integer("next_attempt_at"),
		/** Only while status = 'in_flight'; also the fencing token (spec §7.2). */
		leaseUntil: integer("lease_until"),
		lastHttpStatus: integer("last_http_status"),
		lastError: text("last_error"),
		completedAt: integer("completed_at"),
		createdBy: text("created_by"),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [
		check("deliveries_kind_check", inList("kind", DELIVERY_KINDS)),
		check("deliveries_status_check", inList("status", DELIVERY_STATUSES)),
		index("deliveries_event_idx").on(t.eventId),
		index("deliveries_destination_created_idx").on(
			t.destinationId,
			t.createdAt,
		),
		index("deliveries_status_next_attempt_idx").on(t.status, t.nextAttemptAt),
		index("deliveries_status_enqueued_idx").on(t.status, t.enqueuedAt),
		index("deliveries_status_completed_idx").on(t.status, t.completedAt),
	],
);

export const deliveryAttempts = sqliteTable(
	"delivery_attempts",
	{
		id: text("id").primaryKey(),
		deliveryId: text("delivery_id")
			.notNull()
			.references(() => deliveries.id),
		attemptNo: integer("attempt_no").notNull(),
		startedAt: integer("started_at").notNull(),
		durationMs: integer("duration_ms").notNull(),
		httpStatus: integer("http_status"),
		errorKind: text("error_kind", { enum: ERROR_KINDS }),
		errorMessage: text("error_message"),
		responseSnippet: text("response_snippet"),
	},
	(t) => [
		uniqueIndex("delivery_attempts_delivery_attempt_uq").on(
			t.deliveryId,
			t.attemptNo,
		),
		index("delivery_attempts_started_idx").on(t.startedAt),
		check(
			"delivery_attempts_error_kind_check",
			sql.raw(
				`"error_kind" IS NULL OR "error_kind" IN (${ERROR_KINDS.map((v) => `'${v}'`).join(", ")})`,
			),
		),
	],
);

export const users = sqliteTable(
	"users",
	{
		/** Always lowercased. */
		email: text("email").primaryKey(),
		role: text("role", { enum: ROLES }).notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		disabledAt: integer("disabled_at"),
	},
	() => [check("users_role_check", inList("role", ROLES))],
);

export const auditLogs = sqliteTable(
	"audit_logs",
	{
		id: text("id").primaryKey(),
		actorEmail: text("actor_email").notNull(),
		action: text("action").notNull(),
		resourceType: text("resource_type").notNull(),
		/** NULL for actions over many resources (bulk replay). */
		resourceId: text("resource_id"),
		reason: text("reason"),
		diffJson: text("diff_json", { mode: "json" }).$type<
			Record<string, unknown>
		>(),
		at: integer("at").notNull(),
	},
	(t) => [
		index("audit_logs_at_idx").on(t.at),
		index("audit_logs_resource_idx").on(t.resourceType, t.resourceId, t.at),
		index("audit_logs_actor_idx").on(t.actorEmail, t.at),
	],
);

export const testDeliveries = sqliteTable(
	"test_deliveries",
	{
		id: text("id").primaryKey(),
		destinationId: text("destination_id")
			.notNull()
			.references(() => destinations.id),
		projectId: text("project_id").notNull(),
		actorEmail: text("actor_email").notNull(),
		startedAt: integer("started_at").notNull(),
		durationMs: integer("duration_ms").notNull(),
		httpStatus: integer("http_status"),
		errorKind: text("error_kind", { enum: TEST_ERROR_KINDS }),
		errorMessage: text("error_message"),
		responseSnippet: text("response_snippet"),
	},
	(t) => [
		index("test_deliveries_destination_started_idx").on(
			t.destinationId,
			t.startedAt,
		),
		check(
			"test_deliveries_error_kind_check",
			sql.raw(
				`"error_kind" IS NULL OR "error_kind" IN (${TEST_ERROR_KINDS.map((v) => `'${v}'`).join(", ")})`,
			),
		),
	],
);

export type ProjectRow = typeof projects.$inferSelect;
export type DestinationRow = typeof destinations.$inferSelect;
export type SourceRow = typeof sources.$inferSelect;
export type WebhookEventRow = typeof webhookEvents.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
export type DeliveryAttemptRow = typeof deliveryAttempts.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;
export type TestDeliveryRow = typeof testDeliveries.$inferSelect;

/**
 * Hourly counters filled by the rollup job (spec §5–§6). No foreign keys:
 * stats outlive archived events (M5). `hour` is the start of a UTC hour.
 */
export const statsHourly = sqliteTable(
	"stats_hourly",
	{
		hour: integer("hour").notNull(),
		projectId: text("project_id").notNull(),
		sourceId: text("source_id").notNull(),
		destinationId: text("destination_id").notNull(),
		received: integer("received").notNull().default(0),
		delivered: integer("delivered").notNull().default(0),
		failedFinal: integer("failed_final").notNull().default(0),
		dead: integer("dead").notNull().default(0),
		attempts: integer("attempts").notNull().default(0),
	},
	(t) => [
		primaryKey({
			columns: [t.hour, t.projectId, t.sourceId, t.destinationId],
		}),
		index("stats_hourly_project_hour_idx").on(t.projectId, t.hour),
	],
);

export type StatsHourlyRow = typeof statsHourly.$inferSelect;
