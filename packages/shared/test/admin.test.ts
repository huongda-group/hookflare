import { describe, expect, it } from "vitest";
import {
	alertChannelConfigSchema,
	alertRulesSchema,
	bulkReplayRequest,
	createDestinationRequest,
	createProjectRequest,
	createSourceRequest,
	createUserRequest,
	DEFAULT_ALERT_RULES,
	DEFAULT_STORAGE_SETTINGS,
	eventIdConfigError,
	eventSearchQuery,
	isAllowedAlertUrl,
	listQuery,
	PERMISSIONS,
	patchDestinationRequest,
	patchSettingsRequest,
	patchSourceRequest,
	RANGE_HOURS,
	reasonSchema,
	retryDefaultsSchema,
	rotateDestinationSecretRequest,
	rotateSourceSecretRequest,
	statsQuery,
	storageSettingsSchema,
} from "../src/admin";

const base = { project_id: "prj_1", destination_id: "dst_1", name: "Stripe" };
const hmac = {
	header: "stripe-signature",
	algorithm: "sha256",
	encoding: "hex",
};

describe("createProjectRequest", () => {
	it("accepts a valid slug and rejects bad ones", () => {
		expect(
			createProjectRequest.safeParse({ name: "Shop", slug: "shop-prod" })
				.success,
		).toBe(true);
		for (const slug of ["a", "-shop", "Shop", "shop_prod", "x".repeat(64)]) {
			expect(
				createProjectRequest.safeParse({ name: "Shop", slug }).success,
			).toBe(false);
		}
	});

	it("rejects unknown fields", () => {
		expect(
			createProjectRequest.safeParse({
				name: "Shop",
				slug: "shop",
				status: "active",
			}).success,
		).toBe(false);
	});
});

describe("createDestinationRequest / patchDestinationRequest", () => {
	it("bounds timeout_ms to 1000..30000", () => {
		const ok = { project_id: "prj_1", name: "B", url: "https://b.example.com" };
		expect(
			createDestinationRequest.safeParse({ ...ok, timeout_ms: 1000 }).success,
		).toBe(true);
		expect(
			createDestinationRequest.safeParse({ ...ok, timeout_ms: 999 }).success,
		).toBe(false);
		expect(
			createDestinationRequest.safeParse({ ...ok, timeout_ms: 30001 }).success,
		).toBe(false);
	});

	it("rejects status paused in M1", () => {
		expect(
			patchDestinationRequest.safeParse({ status: "paused" }).success,
		).toBe(false);
		expect(
			patchDestinationRequest.safeParse({ status: "disabled" }).success,
		).toBe(true);
	});
});

describe("createSourceRequest", () => {
	it("accepts none without secret and defaults auth_config/event_id_from", () => {
		const r = createSourceRequest.parse({ ...base, auth_type: "none" });
		expect(r).toMatchObject({ auth_config: {}, event_id_from: "none" });
	});

	it("forbids a secret with auth_type none", () => {
		expect(
			createSourceRequest.safeParse({
				...base,
				auth_type: "none",
				secret: "x".repeat(20),
			}).success,
		).toBe(false);
	});

	it("validates auth_config against auth_type", () => {
		expect(
			createSourceRequest.safeParse({
				...base,
				auth_type: "hmac",
				auth_config: hmac,
			}).success,
		).toBe(true);
		expect(
			createSourceRequest.safeParse({
				...base,
				auth_type: "hmac",
				auth_config: { in: "header", name: "x" },
			}).success,
		).toBe(false);
		expect(
			createSourceRequest.safeParse({
				...base,
				auth_type: "token",
				auth_config: { in: "query", name: "token" },
			}).success,
		).toBe(true);
		expect(
			createSourceRequest.safeParse({
				...base,
				auth_type: "hmac",
				auth_config: { ...hmac, algorithm: "md5" },
			}).success,
		).toBe(false);
	});

	it("requires a valid header name for header tokens only", () => {
		const token = (auth_config: Record<string, unknown>) =>
			createSourceRequest.safeParse({
				...base,
				auth_type: "token",
				auth_config,
			}).success;
		expect(token({ in: "header", name: "X-Token" })).toBe(true);
		expect(token({ in: "header", name: "x token" })).toBe(false);
		expect(token({ in: "header", name: "x:token" })).toBe(false);
		// Query parameter names are not header names.
		expect(token({ in: "query", name: "api key" })).toBe(true);
	});

	it("bounds the secret to 16..512 characters", () => {
		const s = { ...base, auth_type: "hmac", auth_config: hmac };
		expect(
			createSourceRequest.safeParse({ ...s, secret: "x".repeat(15) }).success,
		).toBe(false);
		expect(
			createSourceRequest.safeParse({ ...s, secret: "x".repeat(16) }).success,
		).toBe(true);
		expect(
			createSourceRequest.safeParse({ ...s, secret: "x".repeat(513) }).success,
		).toBe(false);
	});

	it("checks event_id_selector against event_id_from", () => {
		const s = { ...base, auth_type: "none" };
		expect(
			createSourceRequest.safeParse({
				...s,
				event_id_from: "json_path",
				event_id_selector: "$.id",
			}).success,
		).toBe(true);
		expect(
			createSourceRequest.safeParse({
				...s,
				event_id_from: "json_path",
				event_id_selector: "id",
			}).success,
		).toBe(false);
		expect(
			createSourceRequest.safeParse({ ...s, event_id_from: "header" }).success,
		).toBe(false);
		expect(
			createSourceRequest.safeParse({ ...s, event_id_selector: "$.id" })
				.success,
		).toBe(false);
		expect(
			createSourceRequest.safeParse({
				...s,
				event_id_from: "header",
				event_id_selector: "x-event-id",
			}).success,
		).toBe(true);
	});

	it("bounds max_body_bytes to 1..10485760", () => {
		const s = { ...base, auth_type: "none" };
		expect(
			createSourceRequest.safeParse({ ...s, max_body_bytes: 10_485_760 })
				.success,
		).toBe(true);
		expect(
			createSourceRequest.safeParse({ ...s, max_body_bytes: 10_485_761 })
				.success,
		).toBe(false);
		expect(
			createSourceRequest.safeParse({ ...s, max_body_bytes: 0 }).success,
		).toBe(false);
	});
});

describe("patchSourceRequest", () => {
	it("cannot change auth_type or the secret", () => {
		expect(patchSourceRequest.safeParse({ auth_type: "hmac" }).success).toBe(
			false,
		);
		expect(
			patchSourceRequest.safeParse({ secret: "x".repeat(20) }).success,
		).toBe(false);
	});

	it("allows clearing nullable fields", () => {
		expect(
			patchSourceRequest.safeParse({
				max_body_bytes: null,
				event_id_selector: null,
			}).success,
		).toBe(true);
	});
});

describe("eventIdConfigError", () => {
	it("returns null for valid combinations and a message otherwise", () => {
		expect(eventIdConfigError("none", null)).toBeNull();
		expect(eventIdConfigError("header", "x-id")).toBeNull();
		expect(eventIdConfigError("header", "bad header")).toMatch(/header/);
		expect(eventIdConfigError("none", "$.id")).toMatch(/omitted/);
		expect(eventIdConfigError("json_path", null)).toMatch(/required/);
	});
});

describe("listQuery", () => {
	it("coerces limit, defaults to 50, caps at 200", () => {
		expect(listQuery.parse({})).toMatchObject({ limit: 50 });
		expect(listQuery.parse({ limit: "10" })).toMatchObject({ limit: 10 });
		expect(listQuery.safeParse({ limit: "201" }).success).toBe(false);
		expect(listQuery.safeParse({ limit: "0" }).success).toBe(false);
	});
});

describe("M3 schemas", () => {
	it("trims reasons and rejects blank ones", () => {
		expect(reasonSchema.parse("  ok  ")).toBe("ok");
		expect(reasonSchema.safeParse("   ").success).toBe(false);
		expect(reasonSchema.safeParse("x".repeat(501)).success).toBe(false);
	});

	it("bounds and defaults grace_hours", () => {
		expect(rotateDestinationSecretRequest.parse({}).grace_hours).toBe(24);
		expect(
			rotateDestinationSecretRequest.safeParse({ grace_hours: 169 }).success,
		).toBe(false);
		expect(
			rotateSourceSecretRequest.parse({ grace_hours: 0 }).grace_hours,
		).toBe(0);
	});

	it("dedupes bulk replay ids and caps them at 100", () => {
		const id = "dlv_01J0000000000000000000000A";
		expect(
			bulkReplayRequest.parse({ delivery_ids: [id, id], reason: "r" })
				.delivery_ids,
		).toEqual([id]);
		expect(
			bulkReplayRequest.safeParse({
				delivery_ids: Array.from({ length: 101 }, (_, i) => `dlv_${i}`),
				reason: "r",
			}).success,
		).toBe(false);
	});

	it("lowercases user emails", () => {
		expect(
			createUserRequest.parse({ email: "Ops@Example.COM", role: "operator" })
				.email,
		).toBe("ops@example.com");
	});
});

describe("M4 contracts", () => {
	const defaults = {
		timeout_ms: 10_000,
		max_attempts: 20,
		backoff_base_s: 30,
		backoff_max_s: 21_600,
	};

	it("adds settings.manage to PERMISSIONS", () => {
		expect(PERMISSIONS).toContain("settings.manage");
	});

	it("defaults the stats range to 24h and maps ranges to hours", () => {
		expect(statsQuery.parse({})).toEqual({ range: "24h" });
		expect(RANGE_HOURS).toEqual({ "24h": 24, "7d": 168, "30d": 720 });
		expect(statsQuery.safeParse({ range: "1y" }).success).toBe(false);
	});

	it("accepts valid retry defaults and rejects base above max", () => {
		expect(retryDefaultsSchema.parse(defaults)).toEqual(defaults);
		const bad = retryDefaultsSchema.safeParse({
			...defaults,
			backoff_base_s: 600,
			backoff_max_s: 60,
		});
		expect(bad.success).toBe(false);
		expect(bad.error?.issues[0]?.path).toEqual(["backoff_max_s"]);
	});

	it("requires all four retry fields and no unknown keys", () => {
		const { timeout_ms: _t, ...missing } = defaults;
		expect(retryDefaultsSchema.safeParse(missing).success).toBe(false);
		expect(
			patchSettingsRequest.safeParse({ retry_defaults: defaults, extra: 1 })
				.success,
		).toBe(false);
		expect(
			patchSettingsRequest.parse({ retry_defaults: defaults, reason: " r " }),
		).toEqual({ retry_defaults: defaults, reason: "r" });
	});

	it("coerces and bounds the http_status filter", () => {
		expect(eventSearchQuery.parse({ http_status: "503" }).http_status).toBe(
			503,
		);
		expect(eventSearchQuery.safeParse({ http_status: "99" }).success).toBe(
			false,
		);
		expect(eventSearchQuery.safeParse({ http_status: "600" }).success).toBe(
			false,
		);
	});
});

describe("destination limits", () => {
	const base = {
		project_id: "prj_1",
		name: "a",
		url: "https://example.com/h",
	};
	it("accepts 1–1000 and null on patch", () => {
		expect(
			createDestinationRequest.safeParse({
				...base,
				max_in_flight: 1,
				rate_limit_per_s: 1000,
			}).success,
		).toBe(true);
		expect(
			patchDestinationRequest.safeParse({
				max_in_flight: null,
				rate_limit_per_s: null,
			}).success,
		).toBe(true);
	});
	it("rejects 0, 1001, and fractions", () => {
		for (const v of [0, 1001, 1.5]) {
			expect(
				createDestinationRequest.safeParse({ ...base, max_in_flight: v })
					.success,
			).toBe(false);
			expect(
				patchDestinationRequest.safeParse({ rate_limit_per_s: v }).success,
			).toBe(false);
		}
	});
});

describe("alert schemas", () => {
	it("alert_rules defaults are valid and bounds hold", () => {
		expect(alertRulesSchema.safeParse(DEFAULT_ALERT_RULES).success).toBe(true);
		expect(
			alertRulesSchema.safeParse({ ...DEFAULT_ALERT_RULES, reminder_s: 0 })
				.success,
		).toBe(true);
		expect(
			alertRulesSchema.safeParse({ ...DEFAULT_ALERT_RULES, reminder_s: 300 })
				.success,
		).toBe(false);
		expect(
			alertRulesSchema.safeParse({
				...DEFAULT_ALERT_RULES,
				failure_threshold: 1,
			}).success,
		).toBe(false);
		expect(
			alertRulesSchema.safeParse({ ...DEFAULT_ALERT_RULES, d1_warn_pct: 96 })
				.success,
		).toBe(false);
	});

	it("allowlists webhook hosts and paths (M5-10)", () => {
		expect(
			isAllowedAlertUrl("discord", "https://discord.com/api/webhooks/1/abc"),
		).toBe(true);
		expect(
			isAllowedAlertUrl("discord", "https://discordapp.com/api/webhooks/1/abc"),
		).toBe(true);
		expect(
			isAllowedAlertUrl("discord", "http://discord.com/api/webhooks/1/abc"),
		).toBe(false);
		expect(
			isAllowedAlertUrl(
				"discord",
				"https://discord.com.evil.io/api/webhooks/1",
			),
		).toBe(false);
		expect(isAllowedAlertUrl("discord", "https://discord.com/api/other")).toBe(
			false,
		);
		expect(
			isAllowedAlertUrl(
				"discord",
				"https://user:pw@discord.com/api/webhooks/1",
			),
		).toBe(false);
		expect(
			isAllowedAlertUrl("slack", "https://hooks.slack.com/services/T/B/x"),
		).toBe(true);
		expect(
			isAllowedAlertUrl("slack", "https://hooks.slack.com:8443/services/T/B/x"),
		).toBe(false);
	});

	it("validates channel configs by type", () => {
		const tg = {
			type: "telegram",
			bot_token: `123456:${"a".repeat(35)}`,
			chat_id: "-100123",
		};
		expect(alertChannelConfigSchema.safeParse(tg).success).toBe(true);
		expect(
			alertChannelConfigSchema.safeParse({ ...tg, bot_token: "nope" }).success,
		).toBe(false);
		expect(
			alertChannelConfigSchema.safeParse({ ...tg, chat_id: "abc" }).success,
		).toBe(false);
		expect(
			alertChannelConfigSchema.safeParse({
				type: "slack",
				url: "https://discord.com/api/webhooks/1/a",
			}).success,
		).toBe(false);
	});

	it("requires at least one settings section", () => {
		expect(patchSettingsRequest.safeParse({}).success).toBe(false);
		expect(
			patchSettingsRequest.safeParse({ alert_rules: DEFAULT_ALERT_RULES })
				.success,
		).toBe(true);
	});
});

describe("storage settings", () => {
	it("accepts the defaults and enforces failed ≥ hot", () => {
		expect(
			storageSettingsSchema.safeParse(DEFAULT_STORAGE_SETTINGS).success,
		).toBe(true);
		const bad = storageSettingsSchema.safeParse({
			...DEFAULT_STORAGE_SETTINGS,
			hot_retention_days: 40,
			failed_retention_days: 30,
		});
		expect(bad.success).toBe(false);
		if (!bad.success)
			expect(bad.error.issues[0].path).toEqual(["failed_retention_days"]);
	});
	it("allows null archive retention (forever) but not below 30 days", () => {
		expect(
			storageSettingsSchema.safeParse({
				...DEFAULT_STORAGE_SETTINGS,
				archive_retention_days: null,
			}).success,
		).toBe(true);
		expect(
			storageSettingsSchema.safeParse({
				...DEFAULT_STORAGE_SETTINGS,
				archive_retention_days: 29,
			}).success,
		).toBe(false);
	});
});
