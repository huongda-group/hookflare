import type { Settings } from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { clearAccessKeyCache } from "../../src/admin/auth/access";
import { auditLogs, settings } from "../../src/core/db/schema";
import {
	clearRetryDefaultsCache,
	RETRY_DEFAULTS_KEY,
} from "../../src/core/settings";
import { adminApp, auditRows } from "../helpers/admin";
import { testDeps, withFailingBatch } from "../helpers/deps";

const next = {
	timeout_ms: 5000,
	max_attempts: 5,
	backoff_base_s: 10,
	backoff_max_s: 600,
};

beforeEach(async () => {
	clearAccessKeyCache();
	clearRetryDefaultsCache();
	const deps = testDeps();
	await deps.db.delete(settings).where(eq(settings.key, RETRY_DEFAULTS_KEY));
	// Same fixed resource ID in every test: drop audit rows too so the
	// batch-atomicity test sees only rows written by its own request.
	await deps.db
		.delete(auditLogs)
		.where(eq(auditLogs.resourceId, RETRY_DEFAULTS_KEY));
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
});
