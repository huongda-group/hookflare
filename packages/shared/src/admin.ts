import { z } from "zod";
import { parseJsonPath } from "./json-path";

export const PROJECT_STATUSES = ["active", "disabled"] as const;
export const SOURCE_STATUSES = ["active", "disabled"] as const;
export const AUTH_TYPES = ["none", "hmac", "token"] as const;
export const EVENT_ID_FROM = ["none", "header", "json_path"] as const;
/** `paused` is set only by `POST /destinations/:id/pause`. */
const DESTINATION_PATCH_STATUSES = ["active", "disabled"] as const;

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;

const name = z.string().trim().min(1).max(100);
const projectId = z.string().startsWith("prj_").max(64);
const destinationId = z.string().startsWith("dst_").max(64);
const url = z.url().max(2048);
const timeoutMs = z.number().int().min(1000).max(30000);
const maxAttempts = z.number().int().min(1).max(50);
const backoffBaseS = z.number().int().min(1).max(3600);
/** Queues cap delaySeconds at 12 h. ≥ backoff_base_s is checked by the route after defaults. */
const backoffMaxS = z.number().int().min(1).max(43_200);
const maxBodyBytes = z.number().int().min(1).max(10_485_760);
/** M5a: NULL = unlimited. Not part of retry_defaults (limits describe one backend). */
export const destinationLimit = z.number().int().min(1).max(1000);
const secret = z.string().min(16).max(512);

export const reasonSchema = z.string().trim().min(1).max(500);
export const optionalReason = { reason: reasonSchema.optional() };

export const hmacAuthConfig = z.strictObject({
	header: z.string().regex(HEADER_NAME),
	algorithm: z.enum(["sha1", "sha256", "sha512"]),
	encoding: z.enum(["hex", "base64"]),
	prefix: z.string().min(1).max(50).optional(),
});
export const tokenAuthConfig = z
	.strictObject({
		in: z.enum(["header", "query"]),
		name: z.string().min(1).max(100),
	})
	// An invalid header name would make Headers.get() throw on every request.
	.refine((cfg) => cfg.in !== "header" || HEADER_NAME.test(cfg.name), {
		path: ["name"],
		message: "name must be a valid header name when in is header",
	});
export const noneAuthConfig = z.strictObject({});

export type HmacAuthConfig = z.infer<typeof hmacAuthConfig>;
export type TokenAuthConfig = z.infer<typeof tokenAuthConfig>;
export type AuthConfig =
	| HmacAuthConfig
	| TokenAuthConfig
	| Record<string, never>;

export function authConfigSchemaFor(
	type: (typeof AUTH_TYPES)[number],
): z.ZodType<AuthConfig> {
	return type === "hmac"
		? hmacAuthConfig
		: type === "token"
			? tokenAuthConfig
			: noneAuthConfig;
}

/** null when the pair is valid, otherwise a human-readable reason (§6.2). */
export function eventIdConfigError(
	from: string,
	selector: string | null | undefined,
): string | null {
	const hasSelector = selector !== null && selector !== undefined;
	if (from === "none") {
		return hasSelector
			? "event_id_selector must be omitted when event_id_from is none"
			: null;
	}
	if (!hasSelector) {
		return "event_id_selector is required when event_id_from is not none";
	}
	if (from === "header") {
		return HEADER_NAME.test(selector)
			? null
			: "event_id_selector must be a header name";
	}
	return parseJsonPath(selector)
		? null
		: "event_id_selector must be a path like $.id or $.data.items[0].id";
}

function refineEventId(
	value: { event_id_from?: string; event_id_selector?: string | null },
	ctx: z.RefinementCtx,
) {
	const error = eventIdConfigError(
		value.event_id_from ?? "none",
		value.event_id_selector,
	);
	if (error) {
		ctx.addIssue({
			code: "custom",
			path: ["event_id_selector"],
			message: error,
		});
	}
}

export const listQuery = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(50),
	cursor: z.string().max(64).optional(),
	project_id: projectId.optional(),
});

export const createProjectRequest = z.strictObject({
	name,
	slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
	...optionalReason,
});
export const patchProjectRequest = z.strictObject({
	name: name.optional(),
	status: z.enum(PROJECT_STATUSES).optional(),
	...optionalReason,
});

export const createDestinationRequest = z.strictObject({
	project_id: projectId,
	name,
	url,
	timeout_ms: timeoutMs.optional(),
	max_attempts: maxAttempts.optional(),
	backoff_base_s: backoffBaseS.optional(),
	backoff_max_s: backoffMaxS.optional(),
	max_in_flight: destinationLimit.nullable().optional(),
	rate_limit_per_s: destinationLimit.nullable().optional(),
	...optionalReason,
});
export const patchDestinationRequest = z.strictObject({
	name: name.optional(),
	url: url.optional(),
	status: z.enum(DESTINATION_PATCH_STATUSES).optional(),
	timeout_ms: timeoutMs.nullable().optional(),
	max_attempts: maxAttempts.nullable().optional(),
	backoff_base_s: backoffBaseS.nullable().optional(),
	backoff_max_s: backoffMaxS.nullable().optional(),
	max_in_flight: destinationLimit.nullable().optional(),
	rate_limit_per_s: destinationLimit.nullable().optional(),
	...optionalReason,
});

const sourceFields = {
	project_id: projectId,
	destination_id: destinationId,
	name,
	event_id_from: z.enum(EVENT_ID_FROM).default("none"),
	event_id_selector: z.string().min(1).max(256).optional(),
	max_body_bytes: maxBodyBytes.optional(),
	...optionalReason,
};

export const createSourceRequest = z
	.discriminatedUnion("auth_type", [
		z.strictObject({
			...sourceFields,
			auth_type: z.literal("none"),
			auth_config: noneAuthConfig.default({}),
		}),
		z.strictObject({
			...sourceFields,
			auth_type: z.literal("hmac"),
			auth_config: hmacAuthConfig,
			secret: secret.optional(),
		}),
		z.strictObject({
			...sourceFields,
			auth_type: z.literal("token"),
			auth_config: tokenAuthConfig,
			secret: secret.optional(),
		}),
	])
	.superRefine((v, ctx) => refineEventId(v, ctx));

/**
 * auth_config is checked against the stored auth_type, and event_id_* against
 * the merged row, in the route (both need the existing source).
 */
export const patchSourceRequest = z.strictObject({
	name: name.optional(),
	status: z.enum(SOURCE_STATUSES).optional(),
	destination_id: destinationId.optional(),
	auth_config: z.record(z.string(), z.unknown()).optional(),
	event_id_from: z.enum(EVENT_ID_FROM).optional(),
	event_id_selector: z.string().min(1).max(256).nullable().optional(),
	max_body_bytes: maxBodyBytes.nullable().optional(),
	...optionalReason,
});

export type CreateSourceRequest = z.infer<typeof createSourceRequest>;
export type PatchSourceRequest = z.infer<typeof patchSourceRequest>;

// Response shapes (§9.2). The gateway builds them; the dashboard (M4) reads them.
export type Page<T> = { data: T[]; next_cursor: string | null };
export type Project = {
	id: string;
	name: string;
	slug: string;
	status: (typeof PROJECT_STATUSES)[number];
	created_at: number;
	updated_at: number;
};
export type Destination = {
	id: string;
	project_id: string;
	name: string;
	url: string;
	status: "active" | "paused" | "disabled";
	timeout_ms: number | null;
	max_attempts: number | null;
	backoff_base_s: number | null;
	backoff_max_s: number | null;
	max_in_flight: number | null;
	rate_limit_per_s: number | null;
	signing_secret_fingerprint: string;
	previous_secret_fingerprint: string | null;
	previous_secret_expires_at: number | null;
	created_at: number;
	updated_at: number;
};
export type Source = {
	id: string;
	project_id: string;
	destination_id: string;
	name: string;
	status: (typeof SOURCE_STATUSES)[number];
	auth_type: (typeof AUTH_TYPES)[number];
	auth_config: AuthConfig;
	secret_fingerprint: string | null;
	previous_secret_fingerprint: string | null;
	previous_secret_expires_at: number | null;
	event_id_from: (typeof EVENT_ID_FROM)[number];
	event_id_selector: string | null;
	max_body_bytes: number | null;
	ingress_url: string;
	created_at: number;
	updated_at: number;
};
export type DeliveryAttempt = {
	id: string;
	attempt_no: number;
	started_at: number;
	duration_ms: number;
	http_status: number | null;
	error_kind: string | null;
	error_message: string | null;
	response_snippet: string | null;
};
export type Delivery = {
	id: string;
	destination_id: string;
	kind: string;
	status: string;
	attempt_count: number;
	enqueued_at: number | null;
	next_attempt_at: number | null;
	last_http_status: number | null;
	last_error: string | null;
	completed_at: number | null;
	created_at: number;
	created_by: string | null;
	attempts: DeliveryAttempt[];
};
export type WebhookEvent = {
	id: string;
	project_id: string;
	source_id: string;
	provider_event_id: string | null;
	received_at: number;
	headers: Record<string, string>;
	content_type: string | null;
	size_bytes: number;
	payload_sha256: string;
	deliveries: Delivery[];
};

// ---- M3: roles, permissions, and the new endpoints (spec §6–§12) ----

export const ROLES = ["admin", "operator", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export const PERMISSIONS = [
	"events.read",
	"payload.read",
	"deliveries.replay",
	"destinations.operate",
	"config.write",
	"users.manage",
	"audit.read",
	"settings.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const DELIVERY_STATUS_VALUES = [
	"pending",
	"queued",
	"in_flight",
	"retrying",
	"paused",
	"delivered",
	"failed_final",
	"dead",
] as const;
const FAILURE_STATUSES = ["failed_final", "dead"] as const;

const sourceId = z.string().startsWith("src_").max(64);
const deliveryId = z.string().startsWith("dlv_").max(64);
const epochMs = z.coerce.number().int().min(0);
const pageLimit = z.coerce.number().int().min(1).max(100).default(50);
const cursor = z.string().max(512).optional();
/** Query flags arrive as strings. */
const queryBool = z.enum(["true", "false"]).transform((v) => v === "true");
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** Service-token identities (`svc:`) authenticate like users (§6.1). */
export function isServiceIdentity(id: string): boolean {
	return id.startsWith("svc:");
}

const serviceIdentity = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^svc:[a-z0-9._-]{1,200}$/);
/** Either a user email or a service-token identity. */
export const userId = z.union([email, serviceIdentity]);
const graceHours = z.number().int().min(0).max(168).default(24);

/** `status` and `destination_id`-style filters may repeat (`?status=a&status=b`). */
export const eventSearchQuery = z
	.object({
		project_id: projectId.optional(),
		source_id: sourceId.optional(),
		destination_id: destinationId.optional(),
		status: z.array(z.enum(DELIVERY_STATUS_VALUES)).optional(),
		provider_event_id: z.string().min(1).max(256).optional(),
		http_status: z.coerce.number().int().min(100).max(599).optional(),
		from: epochMs.optional(),
		to: epochMs.optional(),
		limit: pageLimit,
		cursor,
	})
	.refine((q) => q.provider_event_id === undefined || q.source_id, {
		path: ["provider_event_id"],
		message: "provider_event_id requires source_id",
	});

export const failuresQuery = z.object({
	status: z.array(z.enum(FAILURE_STATUSES)).optional(),
	project_id: projectId.optional(),
	destination_id: destinationId.optional(),
	from: epochMs.optional(),
	to: epochMs.optional(),
	unresolved: queryBool.default(true),
	limit: pageLimit,
	cursor,
});

export const auditLogQuery = z.object({
	actor_email: userId.optional(),
	resource_type: z.string().min(1).max(50).optional(),
	resource_id: z.string().min(1).max(64).optional(),
	action: z.string().min(1).max(100).optional(),
	from: epochMs.optional(),
	to: epochMs.optional(),
	limit: pageLimit,
	cursor,
});

export const pageQuery = z.object({ limit: pageLimit, cursor });

export const replayRequest = z.strictObject({ reason: reasonSchema });
export const bulkReplayRequest = z.strictObject({
	delivery_ids: z
		.array(deliveryId)
		.min(1)
		.max(100)
		.transform((ids) => [...new Set(ids)]),
	reason: reasonSchema,
});

export const testDeliveryRequest = z.strictObject({
	/** Any JSON; the 64 KiB admin body cap bounds its serialized size. */
	payload: z.unknown().optional(),
	...optionalReason,
});

export const rotateSourceSecretRequest = z.strictObject({
	grace_hours: graceHours,
	secret: secret.optional(),
	...optionalReason,
});
export const rotateDestinationSecretRequest = z.strictObject({
	grace_hours: graceHours,
	...optionalReason,
});

/** Pause/Resume take an optional body. */
export const operateRequest = z.strictObject({ ...optionalReason });

export const createUserRequest = z.strictObject({
	email: userId,
	role: z.enum(ROLES),
	...optionalReason,
});
export const patchUserRequest = z
	.strictObject({
		role: z.enum(ROLES).optional(),
		disabled: z.boolean().optional(),
		...optionalReason,
	})
	.refine((v) => v.role !== undefined || v.disabled !== undefined, {
		message: "role or disabled is required",
	});

export type DeliveryStatusValue = (typeof DELIVERY_STATUS_VALUES)[number];
export type EventSummary = {
	id: string;
	project_id: string;
	source_id: string;
	provider_event_id: string | null;
	received_at: number;
	content_type: string | null;
	size_bytes: number;
	latest_delivery: {
		id: string;
		destination_id: string;
		kind: string;
		status: string;
		attempt_count: number;
		last_http_status: number | null;
		next_attempt_at: number | null;
	} | null;
};
export type Failure = Omit<Delivery, "attempts"> & {
	event_id: string;
	project_id: string;
	source_id: string;
	received_at: number;
	latest_replay: { id: string; status: string } | null;
};
export type ReplayResult = {
	delivery_id: string;
	status: string;
	enqueued: boolean;
};
export type BulkReplayResult = {
	replayed: {
		delivery_id: string;
		new_delivery_id: string;
		enqueued: boolean;
	}[];
	skipped: { delivery_id: string; reason: string }[];
};
export type TestDelivery = {
	id: string;
	destination_id: string;
	actor_email: string;
	started_at: number;
	duration_ms: number;
	http_status: number | null;
	error_kind: string | null;
	error_message: string | null;
	response_snippet: string | null;
};
export type User = {
	email: string;
	role: Role;
	created_at: number;
	updated_at: number;
	disabled_at: number | null;
};
export type Me = { email: string; role: Role; permissions: Permission[] };
export type AuditLog = {
	id: string;
	actor_email: string;
	action: string;
	resource_type: string;
	resource_id: string | null;
	reason: string | null;
	diff: Record<string, unknown> | null;
	at: number;
};

// ---- M4: overview, destination stats, and settings (spec §7) ----

export const STATS_RANGES = ["24h", "7d", "30d"] as const;
export type StatsRange = (typeof STATS_RANGES)[number];
export const RANGE_HOURS: Record<StatsRange, number> = {
	"24h": 24,
	"7d": 168,
	"30d": 720,
};

/** For GET /overview and GET /destinations/stats. */
export const statsQuery = z.object({
	project_id: projectId.optional(),
	range: z.enum(STATS_RANGES).default("24h"),
});

/** Same bounds as the destination policy fields (spec §7.3). */
export const retryDefaultsSchema = z
	.strictObject({
		timeout_ms: timeoutMs,
		max_attempts: maxAttempts,
		backoff_base_s: backoffBaseS,
		backoff_max_s: backoffMaxS,
	})
	.refine((v) => v.backoff_base_s <= v.backoff_max_s, {
		path: ["backoff_max_s"],
		message: "backoff_max_s must be >= backoff_base_s",
	});
export type RetryDefaults = z.infer<typeof retryDefaultsSchema>;

export const ALERT_RULES = [
	"consecutive_failures",
	"new_dead",
	"stuck_pending",
	"d1_storage",
	"archive_stuck",
	"backup_stale",
] as const;
export type AlertRule = (typeof ALERT_RULES)[number];

/** Spec §6.2. reminder_s = 0 means "never remind". */
export const alertRulesSchema = z.strictObject({
	failure_threshold: z.number().int().min(2).max(100),
	stuck_after_s: z.number().int().min(60).max(86_400),
	dead_quiet_s: z.number().int().min(300).max(86_400),
	d1_warn_pct: z.number().int().min(50).max(95),
	reminder_s: z
		.number()
		.int()
		.refine((v) => v === 0 || (v >= 600 && v <= 86_400), {
			message: "Use 0 (never) or 600–86400",
		}),
});
export type AlertRules = z.infer<typeof alertRulesSchema>;
export const DEFAULT_ALERT_RULES: AlertRules = {
	failure_threshold: 5,
	stuck_after_s: 300,
	dead_quiet_s: 1_800,
	d1_warn_pct: 80,
	reminder_s: 3_600,
};

export const ALERT_CHANNEL_TYPES = ["discord", "slack", "telegram"] as const;
export type AlertChannelType = (typeof ALERT_CHANNEL_TYPES)[number];

/** M5-10: alerts only ever go to these endpoints. */
interface ParsedAlertUrl {
	protocol: string;
	username: string;
	password: string;
	port: string;
	hostname: string;
	pathname: string;
}
/** The shared package typechecks without the DOM lib; at runtime this is the global URL. */
declare const URL: new (url: string) => ParsedAlertUrl;
export function isAllowedAlertUrl(
	type: "discord" | "slack",
	raw: string,
): boolean {
	let u: ParsedAlertUrl;
	try {
		u = new URL(raw);
	} catch {
		return false;
	}
	if (u.protocol !== "https:" || u.username || u.password || u.port)
		return false;
	if (type === "discord") {
		return (
			(u.hostname === "discord.com" || u.hostname === "discordapp.com") &&
			u.pathname.startsWith("/api/webhooks/")
		);
	}
	return (
		u.hostname === "hooks.slack.com" && u.pathname.startsWith("/services/")
	);
}

export const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;

const webhookUrl = (type: "discord" | "slack") =>
	z
		.string()
		.max(2048)
		.refine((v) => isAllowedAlertUrl(type, v), {
			message:
				type === "discord"
					? "Use a https://discord.com/api/webhooks/… URL"
					: "Use a https://hooks.slack.com/services/… URL",
		});

export const alertChannelConfigSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("discord"), url: webhookUrl("discord") }),
	z.strictObject({ type: z.literal("slack"), url: webhookUrl("slack") }),
	z.strictObject({
		type: z.literal("telegram"),
		bot_token: z.string().regex(TELEGRAM_TOKEN_RE, "Not a Telegram bot token"),
		chat_id: z
			.string()
			.regex(
				/^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/,
				"Use a numeric chat ID or @channel",
			),
	}),
]);
export type AlertChannelConfig = z.infer<typeof alertChannelConfigSchema>;

const channelRoutes = {
	rules: z.array(z.enum(ALERT_RULES)).max(ALERT_RULES.length),
	project_ids: z.array(projectId).max(50),
};

export const createAlertChannelRequest = z.strictObject({
	name,
	config: alertChannelConfigSchema,
	enabled: z.boolean().default(true),
	rules: channelRoutes.rules.default([]),
	project_ids: channelRoutes.project_ids.default([]),
	...optionalReason,
});
/** `config` replaces the stored one; its type must match the channel's. */
export const patchAlertChannelRequest = z.strictObject({
	name: name.optional(),
	enabled: z.boolean().optional(),
	rules: channelRoutes.rules.optional(),
	project_ids: channelRoutes.project_ids.optional(),
	config: alertChannelConfigSchema.optional(),
	...optionalReason,
});

export const alertsQuery = listQuery.extend({
	status: z.enum(["open", "resolved"]).optional(),
	rule: z.enum(ALERT_RULES).optional(),
});

export type AlertChannel = {
	id: string;
	name: string;
	type: AlertChannelType;
	enabled: boolean;
	rules: AlertRule[];
	project_ids: string[];
	config_fingerprint: string;
	chat_id: string | null;
	created_at: number;
	updated_at: number;
};
export type Alert = {
	id: string;
	rule: AlertRule;
	resource_type: "destination" | "system";
	resource_id: string;
	/** Destination name, or null for system incidents and deleted destinations. */
	resource_name: string | null;
	project_id: string | null;
	status: "open" | "resolved";
	opened_at: number;
	last_notified_at: number | null;
	resolved_at: number | null;
	details: Record<string, unknown>;
};
export type AlertNotification = {
	id: string;
	channel_id: string;
	channel_name: string | null;
	kind: "opened" | "reminder" | "resolved";
	status: "pending" | "sending" | "sent" | "failed";
	tries: number;
	last_error: string | null;
	created_at: number;
	sent_at: number | null;
};
export type AlertDetail = Alert & { notifications: AlertNotification[] };
export type ChannelTestResult = { ok: boolean; error: string | null };

/** Spec §7.2. */
export const storageSettingsSchema = z
	.strictObject({
		archive_enabled: z.boolean(),
		hot_retention_days: z.number().int().min(1).max(3_650),
		failed_retention_days: z.number().int().min(1).max(3_650),
		archive_retention_days: z.number().int().min(30).max(36_500).nullable(),
		audit_retention_days: z.number().int().min(30).max(36_500),
		backup_enabled: z.boolean().default(true),
		backup_retention_days: z.number().int().min(7).max(365).default(35),
	})
	.refine((v) => v.failed_retention_days >= v.hot_retention_days, {
		path: ["failed_retention_days"],
		message: "Must be at least the hot retention",
	});
export type StorageSettings = z.infer<typeof storageSettingsSchema>;
export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
	archive_enabled: true,
	hot_retention_days: 30,
	failed_retention_days: 90,
	archive_retention_days: null,
	audit_retention_days: 365,
	backup_enabled: true,
	backup_retention_days: 35,
};

export const ARCHIVE_KINDS = ["events", "audit"] as const;
export const ARCHIVE_STATUSES = [
	"building",
	"verified",
	"purged",
	"failed",
	"expired",
] as const;
const archiveDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const archivesQuery = z.object({
	limit: z.coerce.number().int().min(1).max(50).default(20),
	cursor: z.string().max(64).optional(),
	kind: z.enum(ARCHIVE_KINDS).optional(),
	status: z.enum(ARCHIVE_STATUSES).optional(),
	from_day: archiveDay.optional(),
	to_day: archiveDay.optional(),
});
export const archivePreviewQuery = z.object({
	hot_retention_days: z.coerce.number().int().min(1).max(3_650),
	failed_retention_days: z.coerce.number().int().min(1).max(3_650),
});
export type ArchivePreview = { eligible: number; currently_eligible: number };

export type ArchivePart = {
	part_no: number;
	item_count: number;
	bytes: number;
	sha256: string | null;
	first_id: string;
	last_id: string;
	downloadable: boolean;
};
export type ArchiveBatch = {
	id: string;
	kind: (typeof ARCHIVE_KINDS)[number];
	day: string;
	status: (typeof ARCHIVE_STATUSES)[number];
	with_files: boolean;
	part_count: number;
	item_count: number;
	bytes: number;
	workflow_instance_id: string;
	error: string | null;
	created_at: number;
	verified_at: number | null;
	purged_at: number | null;
	parts: ArchivePart[];
};
export type ArchiveLastRun = {
	instance_id: string;
	status: string;
	started_at: number;
};

export const BACKUP_STATUSES = ["running", "verified", "failed"] as const;
export type BackupSummary = {
	enabled: boolean;
	last_verified: {
		id: string;
		started_at: number;
		finished_at: number;
		bytes: number;
		rows: number;
	} | null;
	last_failed: { id: string; started_at: number; error: string | null } | null;
	running: { id: string; instance_id: string; started_at: number } | null;
};

export const patchSettingsRequest = z
	.strictObject({
		retry_defaults: retryDefaultsSchema.optional(),
		alert_rules: alertRulesSchema.optional(),
		storage: storageSettingsSchema.optional(),
		...optionalReason,
	})
	.refine(
		(v) =>
			v.retry_defaults !== undefined ||
			v.alert_rules !== undefined ||
			v.storage !== undefined,
		{
			message: "Send at least one settings section",
		},
	);
export type Settings = {
	retry_defaults: RetryDefaults;
	/** retry_defaults' version (kept for M4 clients). */
	updated_at: number | null;
	alert_rules: AlertRules;
	alert_rules_updated_at: number | null;
	storage: StorageSettings;
	storage_updated_at: number | null;
	archive_last_run: ArchiveLastRun | null;
};

/** Non-terminal statuses counted live by the Overview. */
export const LIVE_STATUSES = [
	"pending",
	"queued",
	"in_flight",
	"retrying",
	"paused",
] as const;
export type LiveStatus = (typeof LIVE_STATUSES)[number];

export type TrendPoint = {
	hour: number;
	received: number;
	delivered: number;
	failed: number;
};
export type FailingDestination = {
	destination_id: string;
	name: string | null;
	failed: number;
	delivered: number;
};
export type Overview = {
	range: StatsRange;
	from: number;
	to: number;
	generated_at: number;
	totals: {
		received: number;
		delivered: number;
		failed_final: number;
		dead: number;
		attempts: number;
		success_rate: number | null;
	};
	live: Record<LiveStatus, number>;
	trend: TrendPoint[];
	failing_destinations: FailingDestination[];
	open_alerts: { count: number; by_rule: Partial<Record<AlertRule, number>> };
};
export type DestinationStats = {
	destination_id: string;
	delivered: number;
	failed: number;
	success_rate: number | null;
	last_delivery_at: number | null;
	last_http_status: number | null;
	last_error: string | null;
};
