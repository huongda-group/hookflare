import type { Permission, Role, Settings } from "@hookflare/shared";
import type { Page } from "@playwright/test";

/**
 * Browser-only route-interception fixtures for the redesign verification
 * suite (Task 13). Every admin API call the SPA makes is answered here with
 * deterministic synthetic JSON, so these tests never touch the real D1 that
 * the parallel real-Worker smoke test owns. No test assumes another worker's
 * admin exists: each test installs its own `/auth/state` + `/me` mocks.
 *
 * Data values mirror `src/test/fixtures.ts` and `src/test/server.ts` (same
 * ids, same shapes) so browser assertions exercise the same contracts the
 * Vitest suite locks in.
 */

export const FIXED_NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

const VIEWER_PERMISSIONS: Permission[] = ["events.read"];
const OPERATOR_PERMISSIONS: Permission[] = [
	...VIEWER_PERMISSIONS,
	"payload.read",
	"deliveries.replay",
	"destinations.operate",
];
const ADMIN_PERMISSIONS: Permission[] = [
	...OPERATOR_PERMISSIONS,
	"config.write",
	"users.manage",
	"audit.read",
	"settings.manage",
];

export function permissionsFor(role: Role): Permission[] {
	if (role === "admin") return [...ADMIN_PERMISSIONS];
	if (role === "operator") return [...OPERATOR_PERMISSIONS];
	return [...VIEWER_PERMISSIONS];
}

export function meFor(role: Role, username = `e2e-${role}`) {
	return { username, role, permissions: permissionsFor(role) };
}

export const DEFAULT_AUTH_STATE = {
	setup_required: false,
	turnstile_site_key: null,
};

export const DEFAULT_SETTINGS: Settings = {
	retry_defaults: {
		timeout_ms: 10_000,
		max_attempts: 20,
		backoff_base_s: 30,
		backoff_max_s: 21_600,
	},
	updated_at: null,
	alert_rules: {
		failure_threshold: 5,
		stuck_after_s: 300,
		dead_quiet_s: 1800,
		d1_warn_pct: 80,
		reminder_s: 3600,
	},
	alert_rules_updated_at: null,
	storage: {
		archive_enabled: true,
		hot_retention_days: 30,
		failed_retention_days: 90,
		archive_retention_days: null,
		audit_retention_days: 365,
		backup_enabled: true,
		backup_retention_days: 35,
	},
	storage_updated_at: null,
	archive_last_run: null,
};

const T = FIXED_NOW;

export const rows = {
	project: (o: Record<string, unknown> = {}) => ({
		id: "prj_1",
		name: "Payments",
		slug: "payments",
		status: "active",
		created_at: T,
		updated_at: T,
		...o,
	}),
	destination: (o: Record<string, unknown> = {}) => ({
		id: "dst_1",
		project_id: "prj_1",
		name: "Billing API",
		url: "https://billing.example.com/hooks",
		status: "active",
		timeout_ms: null,
		max_attempts: null,
		backoff_base_s: null,
		backoff_max_s: null,
		max_in_flight: null,
		rate_limit_per_s: null,
		signing_secret_fingerprint: "ab12cd34",
		previous_secret_fingerprint: null,
		previous_secret_expires_at: null,
		created_at: T,
		updated_at: T,
		...o,
	}),
	source: (o: Record<string, unknown> = {}) => ({
		id: "src_1",
		project_id: "prj_1",
		destination_id: "dst_1",
		name: "Stripe",
		status: "active",
		auth_type: "hmac",
		auth_config: {
			header: "Stripe-Signature",
			algorithm: "sha256",
			encoding: "hex",
		},
		secret_fingerprint: "ef56ab78",
		previous_secret_fingerprint: null,
		previous_secret_expires_at: null,
		event_id_from: "none",
		event_id_selector: null,
		max_body_bytes: null,
		ingress_url: "https://hooks.example.com/in/src_1",
		created_at: T,
		updated_at: T,
		...o,
	}),
	eventSummary: (o: Record<string, unknown> = {}) => ({
		id: "evt_1",
		project_id: "prj_1",
		source_id: "src_1",
		provider_event_id: "pi_123",
		received_at: T,
		content_type: "application/json",
		size_bytes: 17,
		latest_delivery: {
			id: "dlv_1",
			destination_id: "dst_1",
			kind: "initial",
			status: "dead",
			attempt_count: 1,
			last_http_status: 503,
			next_attempt_at: null,
		},
		...o,
	}),
	eventDetail: (o: Record<string, unknown> = {}) => ({
		id: "evt_1",
		project_id: "prj_1",
		source_id: "src_1",
		provider_event_id: "pi_123",
		received_at: T,
		headers: { "content-type": "application/json" },
		content_type: "application/json",
		size_bytes: 17,
		payload_sha256: "0".repeat(64),
		deliveries: [
			{
				id: "dlv_1",
				destination_id: "dst_1",
				kind: "initial",
				status: "dead",
				attempt_count: 1,
				enqueued_at: T,
				next_attempt_at: null,
				last_http_status: 503,
				last_error: "HTTP 503",
				completed_at: T + 5000,
				created_at: T,
				created_by: null,
				attempts: [
					{
						id: "att_1",
						attempt_no: 1,
						started_at: T + 1000,
						duration_ms: 120,
						http_status: 503,
						error_kind: "http_5xx",
						error_message: "Service Unavailable",
						response_snippet: "upstream down",
					},
				],
			},
		],
		...o,
	}),
	failure: (o: Record<string, unknown> = {}) => ({
		id: "dlv_1",
		event_id: "evt_1",
		project_id: "prj_1",
		source_id: "src_1",
		destination_id: "dst_1",
		kind: "initial",
		status: "dead",
		attempt_count: 1,
		enqueued_at: T,
		next_attempt_at: null,
		last_http_status: 503,
		last_error: "HTTP 503",
		completed_at: T + 5000,
		created_at: T,
		created_by: null,
		received_at: T,
		latest_replay: null,
		...o,
	}),
	alert: (o: Record<string, unknown> = {}) => ({
		id: "alr_1",
		rule: "consecutive_failures",
		resource_type: "destination",
		resource_id: "dst_1",
		resource_name: "Billing API",
		project_id: "prj_1",
		status: "open",
		opened_at: T - 3_600_000,
		last_notified_at: T - 3_600_000,
		resolved_at: null,
		details: { consecutive_failures: 5 },
		...o,
	}),
	archive: (o: Record<string, unknown> = {}) => ({
		id: "arc_1",
		day: "2026-10-17",
		status: "verified",
		part_count: 2,
		byte_count: 1024,
		created_at: T,
		...o,
	}),
	audit: (o: Record<string, unknown> = {}) => ({
		id: "aud_1",
		actor: "e2e-admin",
		action: "destination.pause",
		resource_type: "destination",
		resource_id: "dst_1",
		reason: "Backend recovered",
		diff: { status: ["active", "paused"] },
		at: T,
		...o,
	}),
	user: (o: Record<string, unknown> = {}) => ({
		username: "op",
		role: "operator",
		status: "active",
		disabled_at: null,
		created_at: T,
		...o,
	}),
	channel: (o: Record<string, unknown> = {}) => ({
		id: "chc_1",
		name: "On-call",
		type: "webhook",
		enabled: true,
		rules: ["consecutive_failures"],
		project_ids: ["prj_1"],
		config_fingerprint: "ff00ff00",
		chat_id: null,
		created_at: T,
		updated_at: T,
		...o,
	}),
};

export function overviewPayload(o: Record<string, unknown> = {}) {
	return {
		range: "24h",
		from: T - 86_400_000,
		to: T,
		generated_at: T,
		totals: {
			received: 12,
			delivered: 9,
			failed_final: 1,
			dead: 2,
			attempts: 30,
			success_rate: 0.75,
		},
		live: {
			pending: 1,
			queued: 0,
			in_flight: 0,
			retrying: 2,
			paused: 1,
			delivered: 0,
			failed_final: 0,
			dead: 0,
		},
		trend: [
			{ hour: T - 86_400_000, received: 4, delivered: 3, failed: 1 },
			{ hour: T - 43_200_000, received: 8, delivered: 6, failed: 2 },
		],
		failing_destinations: [
			{
				destination_id: "dst_1",
				name: "Billing API",
				failed: 3,
				delivered: 6,
			},
		],
		open_alerts: { count: 1, by_rule: { consecutive_failures: 1 } },
		...o,
	};
}

/**
 * Stress dataset: a 100+ character event id, a 200+ character destination
 * URL, and two destinations sharing one name (disambiguated by id in the
 * UI). Used by the overflow/duplicate-name assertions.
 */
export function stressDataset() {
	const longEventId = `evt_${"9".repeat(96)}`;
	const longUrl = `https://hooks.example.com/${"long-path-segment-".repeat(12)}/callback`;
	const longSourceName = `Source ${"ingress-".repeat(24)}`;
	const longDestinationName = `Destination ${"delivery-".repeat(24)}`;
	const longAccountName = `operator-${"account-".repeat(24)}`;
	return {
		longEventId,
		longUrl,
		longSourceName,
		longDestinationName,
		longAccountName,
		projects: [rows.project()],
		destinations: [
			rows.destination({ name: longDestinationName }),
			rows.destination({ id: "dst_2", name: "Billing API" }),
			rows.destination({ id: "dst_3", name: "Long URL hook", url: longUrl }),
		],
		sources: [rows.source({ name: longSourceName })],
		events: [rows.eventSummary({ id: longEventId })],
		eventDetail: rows.eventDetail({ id: longEventId }),
		failures: [
			rows.failure({ id: `dlv_${"8".repeat(60)}`, event_id: longEventId }),
		],
	};
}

export type LoggedRequest = { method: string; path: string };

export type ListMode =
	| { kind: "data"; items: Record<string, unknown>[] }
	| { kind: "empty" }
	| { kind: "error"; code?: string };

export type AppOptions = {
	role?: Role;
	username?: string;
	authState?: { setup_required: boolean; turnstile_site_key: string | null };
	/** POST /auth/login behaviour for the login-form test. */
	login?: { kind: "ok" } | { kind: "error"; status: number; code: string };
	overview?: Record<string, unknown> | { error: string };
	events?: ListMode;
	eventDetail?: Record<string, unknown> | { error: string };
	payload?:
		| { kind: "ok"; body?: string }
		| { kind: "missing" }
		| { kind: "error" };
	failures?: ListMode;
	/** When true, any list request carrying a `cursor` param fails. */
	failNextPage?: boolean;
	projects?: ListMode;
	sources?: ListMode;
	destinations?: ListMode;
	destinationDetail?: Record<string, unknown> | null;
	sourceDetail?: Record<string, unknown> | null;
	/** POST /failures/replay behaviour (`enqueued: false` lands the outcome
	 * in the dialog's "Awaiting enqueue" section). */
	bulkReplay?:
		| { kind: "ok"; enqueued?: boolean }
		| { kind: "error"; status: number; code: string };
	/** POST /events/:id/replay behaviour. */
	singleReplay?:
		| { kind: "ok" }
		| { kind: "error"; status: number; code: string };
	/** PATCH /users/:username behaviour (role-matrix blocked mutation). */
	patchUser?: { kind: "ok" } | { kind: "error"; status: number; code: string };
	users?: ListMode;
	alerts?: ListMode;
	alertDetail?: Record<string, unknown> | null;
	archives?: ListMode;
	archivePreview?: Record<string, unknown> | { error: string };
	auditLogs?: ListMode;
	settings?: Settings;
	backupSummary?: Record<string, unknown>;
	channels?: Record<string, unknown>[];
	/** POST /destinations behaviour for the secret-lifecycle test. */
	createDestination?:
		| { kind: "ok"; secret?: string }
		| { kind: "error"; status: number; code: string };
	/** Deterministic clock (default true). Must be installed pre-navigation. */
	clock?: boolean;
};

function toList(
	mode: ListMode | undefined,
	fallback: Record<string, unknown>[],
) {
	if (!mode) return { data: fallback, next_cursor: null };
	if (mode.kind === "empty") return { data: [], next_cursor: null };
	if (mode.kind === "error")
		return { error: { error: mode.code ?? "internal", message: "boom" } };
	return { data: mode.items, next_cursor: null };
}

function isErrorBody(v: unknown): v is { error: { error: string } } {
	return (
		typeof v === "object" &&
		v !== null &&
		"error" in v &&
		typeof (v as { error: unknown }).error === "object"
	);
}

/**
 * Install the mocked app shell: deterministic clock + a single API route
 * handler answering every admin endpoint the SPA can call. Returns the
 * request log (for no-auto-fetch assertions), a `setRole` handle that
 * swaps the served role without reinstalling, and an `update` handle that
 * merges new fixture options into the single live route handler. Call it at
 * swaps the `/me` response mid-test (role downgrade without reload races).
 */
export async function installApp(page: Page, opts: AppOptions = {}) {
	const requests: LoggedRequest[] = [];
	const live: AppOptions = { ...opts };
	let role: Role = live.role ?? "admin";
	const username = live.username ?? `e2e-${live.role ?? "admin"}`;

	if (live.clock !== false) {
		await page.addInitScript((fixed) => {
			Date.now = () => fixed as number;
		}, FIXED_NOW);
	}

	await page.route("**/api/admin/v1/**", async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname.replace("/api/admin/v1", "") || "/";
		requests.push({ method: req.method(), path: `${path}${url.search}` });

		const json = (body: unknown, status = 200) =>
			route.fulfill({
				status,
				contentType: "application/json",
				body: JSON.stringify(body),
			});
		const fail = (status: number, code: string) =>
			json({ error: code, message: code }, status);

		// Cursor pagination failure injection (Task 2 next-page-error path).
		if (
			live.failNextPage &&
			req.method() === "GET" &&
			url.searchParams.has("cursor")
		) {
			await fail(500, "internal");
			return;
		}

		// --- auth + identity (never the real worker) ---
		if (path === "/auth/state" && req.method() === "GET")
			return json(live.authState ?? DEFAULT_AUTH_STATE);
		if (path === "/me" && req.method() === "GET")
			return json(meFor(role, username));
		if (path === "/auth/login" && req.method() === "POST") {
			if (live.login?.kind === "error")
				return fail(live.login.status, live.login.code);
			return route.fulfill({ status: 204, body: "" });
		}
		if (path === "/auth/setup" && req.method() === "POST")
			return route.fulfill({ status: 204, body: "" });
		if (path === "/auth/logout" && req.method() === "POST")
			return route.fulfill({ status: 204, body: "" });
		if (path === "/me/password" && req.method() === "POST")
			return route.fulfill({ status: 204, body: "" });

		// --- overview + events ---
		if (path === "/overview" && req.method() === "GET") {
			if (live.overview && "error" in live.overview)
				return fail(500, (live.overview as { error: string }).error);
			return json(live.overview ?? overviewPayload());
		}
		if (path === "/events" && req.method() === "GET")
			return (() => {
				const list = toList(live.events, [rows.eventSummary()]);
				return isErrorBody(list) ? fail(500, "internal") : json(list);
			})();
		const eventDetailMatch = path.match(/^\/events\/([^/]+)$/);
		if (eventDetailMatch && req.method() === "GET") {
			if (live.eventDetail && "error" in live.eventDetail)
				return fail(404, (live.eventDetail as { error: string }).error);
			const detail =
				(live.eventDetail as Record<string, unknown> | undefined) ??
				rows.eventDetail({ id: eventDetailMatch[1] });
			return json(detail);
		}
		const payloadMatch = path.match(/^\/events\/([^/]+)\/payload$/);
		if (payloadMatch) {
			const mode = live.payload ?? { kind: "ok" };
			if (mode.kind === "missing") return fail(404, "payload_missing");
			if (mode.kind === "error") return fail(503, "temporarily_unavailable");
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: mode.body ?? `{"event":"${payloadMatch[1]}","ok":true}`,
			});
		}
		const singleReplayMatch = path.match(/^\/events\/([^/]+)\/replay$/);
		if (singleReplayMatch && req.method() === "POST") {
			if (live.singleReplay?.kind === "error")
				return fail(live.singleReplay.status, live.singleReplay.code);
			return json({
				delivery_id: "dlv_new1",
				enqueued: true,
				status: "queued",
			});
		}

		// --- failures ---
		if (path === "/failures" && req.method() === "GET")
			return (() => {
				const list = toList(live.failures, [rows.failure()]);
				return isErrorBody(list) ? fail(500, "internal") : json(list);
			})();
		if (path === "/failures/replay" && req.method() === "POST") {
			if (live.bulkReplay?.kind === "error")
				return fail(live.bulkReplay.status, live.bulkReplay.code);
			let ids: string[] = ["dlv_1"];
			try {
				ids = (req.postDataJSON()?.delivery_ids as string[]) ?? ids;
			} catch {
				/* keep default */
			}
			return json({
				replayed: ids.map((id, i) => ({
					delivery_id: id,
					new_delivery_id: `dlv_new${i + 1}`,
					enqueued:
						live.bulkReplay?.kind !== "ok" ||
						live.bulkReplay.enqueued !== false,
					status: "queued",
				})),
				skipped: [],
			});
		}

		// --- resource lists (cursor paging honoured) ---
		const paged = (
			all: Record<string, unknown>[],
			mode: ListMode | undefined,
		) => {
			if (mode?.kind === "error") return fail(500, mode.code ?? "internal");
			const items = mode?.kind === "data" ? mode.items : all;
			const limit = Number(url.searchParams.get("limit") ?? "50");
			const cursor = url.searchParams.get("cursor");
			const start = cursor ? Number(cursor) : 0;
			const slice = items.slice(start, start + limit);
			return json({
				data: slice,
				next_cursor:
					start + limit < items.length ? String(start + limit) : null,
			});
		};
		if (path === "/projects" && req.method() === "GET")
			return paged([rows.project()], live.projects);
		if (path === "/sources" && req.method() === "GET")
			return paged([rows.source()], live.sources);
		if (path === "/destinations" && req.method() === "GET")
			return paged([rows.destination()], live.destinations);
		const projectOne = path.match(/^\/projects\/([^/]+)$/);
		if (projectOne && req.method() === "GET")
			return json(rows.project({ id: projectOne[1] }));
		if (path === "/projects" && req.method() === "POST")
			return json(rows.project({ id: "prj_new", name: "Created" }), 201);
		const destOne = path.match(/^\/destinations\/([^/]+)$/);
		if (destOne && req.method() === "GET") {
			if (live.destinationDetail) return json(live.destinationDetail);
			return json(rows.destination({ id: destOne[1] }));
		}
		if (path === "/destinations" && req.method() === "POST") {
			if (live.createDestination?.kind === "error")
				return fail(live.createDestination.status, live.createDestination.code);
			return json(
				{
					...rows.destination({
						id: "dst_new",
						project_id: "prj_1",
						name: "Created",
					}),
					signing_secret:
						live.createDestination?.secret ?? "whsec_e2e_secret_value",
				},
				201,
			);
		}
		const srcOne = path.match(/^\/sources\/([^/]+)$/);
		if (srcOne && req.method() === "GET") {
			if (live.sourceDetail) return json(live.sourceDetail);
			return json(rows.source({ id: srcOne[1] }));
		}
		if (path === "/destinations/stats" && req.method() === "GET")
			return json({ data: [] });
		if (path.match(/^\/destinations\/[^/]+\/tests$/) && req.method() === "GET")
			return json({ data: [], next_cursor: null });
		const operateMatch = path.match(
			/^\/(destinations|sources|projects)\/([^/]+)\/(pause|resume)$/,
		);
		if (operateMatch && req.method() === "POST")
			return json({ id: operateMatch[2], status: "ok" });
		const patchOne = path.match(/^\/(destinations|sources|projects)\/([^/]+)$/);
		if (patchOne && req.method() === "PATCH") {
			const [, kind, id] = patchOne;
			if (kind === "destinations") return json(rows.destination({ id }));
			if (kind === "sources") return json(rows.source({ id }));
			return json(rows.project({ id }));
		}

		// --- alerts / archives / audit ---
		if (path === "/alerts" && req.method() === "GET")
			return (() => {
				const list = toList(live.alerts, [rows.alert()]);
				return isErrorBody(list) ? fail(500, "internal") : json(list);
			})();
		const alertOne = path.match(/^\/alerts\/([^/]+)$/);
		if (alertOne && req.method() === "GET")
			return json({
				...rows.alert({ id: alertOne[1] }),
				...(live.alertDetail ?? {}),
				notifications: [],
			});
		if (path === "/archives" && req.method() === "GET")
			return (() => {
				const list = toList(live.archives, [rows.archive()]);
				return isErrorBody(list) ? fail(500, "internal") : json(list);
			})();
		if (path === "/archives/preview" && req.method() === "GET") {
			if (live.archivePreview && "error" in live.archivePreview)
				return fail(503, (live.archivePreview as { error: string }).error);
			return json(
				live.archivePreview ?? { would_delete: false, files: 0, bytes: 0 },
			);
		}
		if (path === "/audit-logs" && req.method() === "GET")
			return (() => {
				const list = toList(live.auditLogs, [rows.audit()]);
				return isErrorBody(list) ? fail(500, "internal") : json(list);
			})();

		// --- settings / users / channels / backups ---
		if (path === "/settings" && req.method() === "GET")
			return json(live.settings ?? DEFAULT_SETTINGS);
		if (path === "/settings" && req.method() === "PATCH")
			return json(live.settings ?? DEFAULT_SETTINGS);
		if (path === "/backups/summary" && req.method() === "GET")
			return json(
				live.backupSummary ?? {
					enabled: true,
					last_verified: null,
					last_failed: null,
					running: null,
				},
			);
		if (path === "/alert-channels" && req.method() === "GET")
			return json({ data: live.channels ?? [rows.channel()] });
		if (path === "/users" && req.method() === "GET")
			return (() => {
				const list = toList(live.users, [rows.user()]);
				return isErrorBody(list) ? fail(500, "internal") : json(list);
			})();
		const userPatch = path.match(/^\/users\/(.+)$/);
		if (userPatch && req.method() === "PATCH") {
			if (live.patchUser?.kind === "error")
				return fail(live.patchUser.status, live.patchUser.code);
			return json(rows.user({ username: decodeURIComponent(userPatch[1]) }));
		}
		if (path.match(/^\/users\/.+\/password$/) && req.method() === "POST")
			return route.fulfill({ status: 204, body: "" });

		// Anything unmocked is a fixture gap, not the real worker: fail loud.
		return fail(404, "not_found");
	});

	return {
		requests,
		setRole(next: Role) {
			role = next;
		},
		/** Merge new fixture options; the single route handler reads them live. */
		update(patch: AppOptions) {
			Object.assign(live, patch);
		},
		payloadRequests() {
			return requests.filter((r) => r.path.includes("/payload"));
		},
	};
}

/** Page-level horizontal overflow in CSS pixels (must be 0). */
export async function pageOverflow(page: Page): Promise<number> {
	return page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
}

/** Local scroll metrics for a scrollable region (tables/code). */
export async function regionMetrics(page: Page, selector: string) {
	const el = page.locator(selector).first();
	return el.evaluate((node) => ({
		scrollWidth: node.scrollWidth,
		clientWidth: node.clientWidth,
	}));
}
