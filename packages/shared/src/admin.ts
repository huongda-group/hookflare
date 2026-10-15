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
const secret = z.string().min(16).max(512);

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
});
export const patchProjectRequest = z.strictObject({
	name: name.optional(),
	status: z.enum(PROJECT_STATUSES).optional(),
});

export const createDestinationRequest = z.strictObject({
	project_id: projectId,
	name,
	url,
	timeout_ms: timeoutMs.optional(),
	max_attempts: maxAttempts.optional(),
	backoff_base_s: backoffBaseS.optional(),
	backoff_max_s: backoffMaxS.optional(),
});
export const patchDestinationRequest = z.strictObject({
	name: name.optional(),
	url: url.optional(),
	status: z.enum(DESTINATION_PATCH_STATUSES).optional(),
	timeout_ms: timeoutMs.nullable().optional(),
	max_attempts: maxAttempts.nullable().optional(),
	backoff_base_s: backoffBaseS.nullable().optional(),
	backoff_max_s: backoffMaxS.nullable().optional(),
});

const sourceFields = {
	project_id: projectId,
	destination_id: destinationId,
	name,
	event_id_from: z.enum(EVENT_ID_FROM).default("none"),
	event_id_selector: z.string().min(1).max(256).optional(),
	max_body_bytes: maxBodyBytes.optional(),
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
	signing_secret_fingerprint: string;
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
