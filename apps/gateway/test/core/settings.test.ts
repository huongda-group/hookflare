import { DEFAULT_ALERT_RULES } from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { settings } from "../../src/core/db/schema";
import { DEFAULT_POLICY } from "../../src/core/policy";
import {
	ALERT_RULES_SETTING,
	clearRetryDefaultsCache,
	clearSettingsCache,
	loadAlertRules,
	loadRetryDefaults,
	RETRY_DEFAULTS_KEY,
	readRetryDefaults,
	readSetting,
	SETTINGS_CACHE_TTL_MS,
	upsertRetryDefaults,
	upsertSetting,
} from "../../src/core/settings";
import { testDeps } from "../helpers/deps";

const custom = {
	timeout_ms: 5000,
	max_attempts: 3,
	backoff_base_s: 10,
	backoff_max_s: 600,
};

beforeEach(async () => {
	clearRetryDefaultsCache();
	await testDeps()
		.db.delete(settings)
		.where(eq(settings.key, RETRY_DEFAULTS_KEY));
});

describe("retry defaults", () => {
	it("returns DEFAULT_POLICY and no timestamp when no row exists", async () => {
		expect(await readRetryDefaults(testDeps().db)).toEqual({
			policy: DEFAULT_POLICY,
			updatedAt: null,
			corrupt: false,
		});
	});

	it("reads back an upserted value", async () => {
		const { db } = testDeps();
		await upsertRetryDefaults(db, custom, 1234);
		await upsertRetryDefaults(db, { ...custom, max_attempts: 4 }, 5678);
		expect(await readRetryDefaults(db)).toEqual({
			policy: {
				timeoutMs: 5000,
				maxAttempts: 4,
				backoffBaseS: 10,
				backoffMaxS: 600,
			},
			updatedAt: 5678,
			corrupt: false,
		});
	});

	it("falls back to DEFAULT_POLICY for an invalid stored value", async () => {
		const { db } = testDeps();
		for (const valueJson of ["not json", '{"timeout_ms": 1}']) {
			await db
				.insert(settings)
				.values({ key: RETRY_DEFAULTS_KEY, valueJson, updatedAt: 1 })
				.onConflictDoUpdate({ target: settings.key, set: { valueJson } });
			expect(await readRetryDefaults(db)).toMatchObject({
				policy: DEFAULT_POLICY,
				corrupt: true,
			});
		}
	});

	it("caches per isolate until the TTL passes", async () => {
		let now = 1_000_000;
		const deps = { ...testDeps(), now: () => now };
		expect(await loadRetryDefaults(deps)).toEqual(DEFAULT_POLICY);
		await upsertRetryDefaults(deps.db, custom, now);
		expect(await loadRetryDefaults(deps)).toEqual(DEFAULT_POLICY);
		now += SETTINGS_CACHE_TTL_MS;
		expect((await loadRetryDefaults(deps)).maxAttempts).toBe(3);
	});
});

describe("generic settings", () => {
	const deps = testDeps();
	beforeEach(async () => {
		clearSettingsCache();
		await deps.db.delete(settings).where(eq(settings.key, "alert_rules"));
	});

	it("falls back to defaults when missing or corrupt", async () => {
		expect(await readSetting(deps.db, ALERT_RULES_SETTING)).toEqual({
			value: DEFAULT_ALERT_RULES,
			updatedAt: null,
			corrupt: false,
		});
		await deps.db
			.insert(settings)
			.values({ key: "alert_rules", valueJson: "{bad", updatedAt: 5 });
		expect(await readSetting(deps.db, ALERT_RULES_SETTING)).toEqual({
			value: DEFAULT_ALERT_RULES,
			updatedAt: 5,
			corrupt: true,
		});
	});

	it("compare-and-swaps on updated_at", async () => {
		const v = { ...DEFAULT_ALERT_RULES, failure_threshold: 9 };
		expect(
			await upsertSetting(deps.db, "alert_rules", v, 10, null),
		).toHaveLength(1);
		expect(
			await upsertSetting(deps.db, "alert_rules", v, 11, null),
		).toHaveLength(0);
		expect(await upsertSetting(deps.db, "alert_rules", v, 12, 10)).toHaveLength(
			1,
		);
	});

	it("caches for 30 s per isolate", async () => {
		let now = 1_000;
		const d = { ...deps, now: () => now };
		expect((await loadAlertRules(d)).failure_threshold).toBe(5);
		await upsertSetting(
			deps.db,
			"alert_rules",
			{ ...DEFAULT_ALERT_RULES, failure_threshold: 9 },
			2,
		);
		expect((await loadAlertRules(d)).failure_threshold).toBe(5);
		now += 30_001;
		expect((await loadAlertRules(d)).failure_threshold).toBe(9);
	});
});
