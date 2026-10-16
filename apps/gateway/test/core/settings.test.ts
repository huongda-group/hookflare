import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { settings } from "../../src/core/db/schema";
import { DEFAULT_POLICY } from "../../src/core/policy";
import {
	clearRetryDefaultsCache,
	loadRetryDefaults,
	RETRY_DEFAULTS_KEY,
	readRetryDefaults,
	SETTINGS_CACHE_TTL_MS,
	upsertRetryDefaults,
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
