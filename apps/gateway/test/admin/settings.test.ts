import {
	DEFAULT_ALERT_RULES,
	DEFAULT_STORAGE_SETTINGS,
	type Settings,
} from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { clearAccessKeyCache } from "../../src/admin/auth/access";
import { auditLogs, settings } from "../../src/core/db/schema";
import {
	ALERT_RULES_SETTING,
	clearSettingsCache,
	RETRY_DEFAULTS_KEY,
	STORAGE_SETTING,
	upsertRetryDefaults,
} from "../../src/core/settings";
import { adminApp, auditRows, beforeNextBatch } from "../helpers/admin";
import { testDeps, withFailingBatch } from "../helpers/deps";

const next = {
	timeout_ms: 5000,
	max_attempts: 5,
	backoff_base_s: 10,
	backoff_max_s: 600,
};

beforeEach(async () => {
	clearAccessKeyCache();
	clearSettingsCache();
	const deps = testDeps();
	await deps.db.delete(settings).where(eq(settings.key, RETRY_DEFAULTS_KEY));
	await deps.db
		.delete(settings)
		.where(eq(settings.key, ALERT_RULES_SETTING.key));
	await deps.db.delete(settings).where(eq(settings.key, STORAGE_SETTING.key));
	// Same fixed resource ID in every test: drop audit rows too so the
	// batch-atomicity test sees only rows written by its own request.
	await deps.db
		.delete(auditLogs)
		.where(eq(auditLogs.resourceId, RETRY_DEFAULTS_KEY));
	await deps.db
		.delete(auditLogs)
		.where(eq(auditLogs.resourceId, ALERT_RULES_SETTING.key));
});

describe("GET /settings", () => {
	it("returns DEFAULT_POLICY to a viewer when nothing is stored", async () => {
		const api = await adminApp(testDeps(), { role: "viewer" });
		const res = await api.request("GET", "/settings");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			retry_defaults: {
				timeout_ms: 10_000,
				max_attempts: 20,
				backoff_base_s: 30,
				backoff_max_s: 21_600,
			},
			updated_at: null,
			alert_rules: DEFAULT_ALERT_RULES,
			alert_rules_updated_at: null,
			storage: DEFAULT_STORAGE_SETTINGS,
			storage_updated_at: null,
			archive_last_run: null,
		} satisfies Settings);
	});
});

describe("PATCH /settings", () => {
	it("stores the defaults and audits before/after in one batch", async () => {
		const deps = testDeps();
		const api = await adminApp(deps);
		const res = await api.request("PATCH", "/settings", {
			retry_defaults: next,
			reason: "tighter retries",
		});
		expect(res.status).toBe(200);
		const body = await res.json<Settings>();
		expect(body.retry_defaults).toEqual(next);
		expect(body.updated_at).toEqual(expect.any(Number));
		const get = await (await api.request("GET", "/settings")).json<Settings>();
		expect(get).toEqual(body);
		const [audit] = await auditRows(deps, RETRY_DEFAULTS_KEY);
		expect(audit).toMatchObject({
			action: "settings.updated",
			resourceType: "settings",
			reason: "tighter retries",
			diffJson: {
				before: { max_attempts: 20, backoff_max_s: 21_600 },
				after: next,
			},
		});
	});

	it("forbids operators", async () => {
		const api = await adminApp(testDeps(), { role: "operator" });
		const res = await api.request("PATCH", "/settings", {
			retry_defaults: next,
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({
			error: "forbidden",
			required: "settings.manage",
		});
	});

	it("rejects base above max with the field path", async () => {
		const api = await adminApp(testDeps());
		const res = await api.request("PATCH", "/settings", {
			retry_defaults: { ...next, backoff_base_s: 900 },
		});
		expect(res.status).toBe(400);
		const body = await res.json<{ issues: { path: string }[] }>();
		expect(body.issues.map((i) => i.path)).toContain(
			"retry_defaults.backoff_max_s",
		);
	});

	it("advances updated_at when two updates land in the same millisecond", async () => {
		// updated_at is the compare-and-swap version: a repeat of the stored
		// value would let a writer that read the previous version slip through.
		const deps = testDeps({ now: () => 1_000 });
		const api = await adminApp(deps);
		const first = await api.request("PATCH", "/settings", {
			retry_defaults: next,
		});
		expect((await first.json<Settings>()).updated_at).toBe(1_000);
		const second = await api.request("PATCH", "/settings", {
			retry_defaults: { ...next, max_attempts: 6 },
		});
		expect(second.status).toBe(200);
		expect((await second.json<Settings>()).updated_at).toBe(1_001);
	});

	it("answers 409 and writes no audit row when another update wins the race", async () => {
		const deps = testDeps();
		const api = await adminApp(deps);
		await api.request("GET", "/me"); // bootstrap batch happens here
		beforeNextBatch(deps, () =>
			upsertRetryDefaults(deps.db, { ...next, max_attempts: 9 }, 1),
		);
		const res = await api.request("PATCH", "/settings", {
			retry_defaults: next,
		});
		expect(res.status).toBe(409);
		expect(await auditRows(deps, RETRY_DEFAULTS_KEY)).toEqual([]);
		const stored = await (
			await api.request("GET", "/settings")
		).json<Settings>();
		expect(stored.retry_defaults.max_attempts).toBe(9);
	});

	it("writes neither the setting nor the audit row when the batch fails", async () => {
		const deps = testDeps();
		const failing = { ...deps, db: withFailingBatch(deps.db) };
		const api = await adminApp(failing);
		const res = await api.request("PATCH", "/settings", {
			retry_defaults: next,
		});
		expect(res.status).toBe(500);
		expect(
			await deps.db
				.select()
				.from(settings)
				.where(eq(settings.key, RETRY_DEFAULTS_KEY)),
		).toEqual([]);
		expect(await auditRows(deps, RETRY_DEFAULTS_KEY)).toEqual([]);
	});

	it("returns alert_rules defaults and patches them independently", async () => {
		const deps = testDeps();
		const app = await adminApp(deps);
		const got = await (await app.request("GET", "/settings")).json<Settings>();
		expect(got.alert_rules).toEqual(DEFAULT_ALERT_RULES);
		expect(got.alert_rules_updated_at).toBeNull();

		const next = { ...DEFAULT_ALERT_RULES, failure_threshold: 8 };
		const res = await app.request("PATCH", "/settings", { alert_rules: next });
		expect(res.status).toBe(200);
		const body = await res.json<Settings>();
		expect(body.alert_rules).toEqual(next);
		expect(body.alert_rules_updated_at).toEqual(expect.any(Number));
		// retry_defaults untouched
		expect(body.updated_at).toBeNull();
		const audits = await auditRows(deps, "alert_rules");
		expect(audits.map((a) => a.action)).toEqual(["settings.updated"]);
	});

	it("rejects an empty PATCH", async () => {
		const api = await adminApp(testDeps());
		const res = await api.request("PATCH", "/settings", {});
		expect(res.status).toBe(400);
	});

	it("returns storage defaults and validates failed ≥ hot", async () => {
		const app = await adminApp(testDeps());
		const got = await (await app.request("GET", "/settings")).json<Settings>();
		expect(got.storage).toEqual(DEFAULT_STORAGE_SETTINGS);
		const bad = await app.request("PATCH", "/settings", {
			storage: { ...DEFAULT_STORAGE_SETTINGS, hot_retention_days: 100 },
		});
		expect(bad.status).toBe(400);
		const ok = await app.request("PATCH", "/settings", {
			storage: { ...DEFAULT_STORAGE_SETTINGS, archive_enabled: false },
		});
		expect((await ok.json<Settings>()).storage.archive_enabled).toBe(false);
	});
});
