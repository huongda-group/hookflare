import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/app";

// Test-only route that triggers the app's onError path. Registered here in
// the test process only — no extra routes are added to src/.
app.get("/__test_boom__", () => {
	throw new Error("super-secret-boom-message");
});

describe("app", () => {
	it("GET /healthz returns 200 when D1 is healthy (migrations applied)", async () => {
		// Proves the setup file applied migrations before this file ran.
		const table = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
		).first<{ name: string }>();
		expect(table).toMatchObject({ name: "settings" });

		const res = await app.request("/healthz", {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ status: "ok" });
		expect(typeof body.version).toBe("string");
	});

	it("GET /healthz returns 503 when D1 throws", async () => {
		const brokenEnv = {
			...env,
			DB: {
				prepare: () => {
					throw new Error("d1 is down");
				},
			},
		};
		const res = await app.request(
			"/healthz",
			{},
			brokenEnv as unknown as typeof env,
		);
		expect(res.status).toBe(503);
		await expect(res.json()).resolves.toMatchObject({ status: "degraded" });
	});

	it("unknown routes return 404 JSON", async () => {
		const res = await app.request("/no-such-route", {}, env);
		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "not_found" });
	});

	it("thrown errors return 500 without leaking the message", async () => {
		const res = await app.request("/__test_boom__", {}, env);
		expect(res.status).toBe(500);
		const text = await res.text();
		expect(text).not.toContain("super-secret-boom-message");
		const body = JSON.parse(text) as Record<string, unknown>;
		expect(body.error).toBe("internal_error");
		expect(typeof body.request_id).toBe("string");
	});

	it("exposes fixed test secret keys", () => {
		expect(env.SECRETS_KEY).toBe(
			"ERERERERERERERERERERERERERERERERERERERERERE=",
		);
		expect(env.SECRETS_KEY_PREVIOUS).toBe(
			"IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
		);
	});
});
