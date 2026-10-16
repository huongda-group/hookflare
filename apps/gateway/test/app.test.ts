import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";

const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
	errorSpy.mockClear();
});

function envWithDb(db: unknown): typeof env {
	return { ...env, DB: db } as unknown as typeof env;
}

describe("app", () => {
	it("GET /healthz returns 200 when D1 is healthy (migrations applied)", async () => {
		// Proves the setup file applied migrations before this file ran.
		const table = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
		).first<{ name: string }>();
		expect(table).toMatchObject({ name: "settings" });

		const res = await createApp().request("/healthz", {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ status: "ok" });
		expect(typeof body.version).toBe("string");
	});

	it("GET /healthz returns 503 when D1 throws", async () => {
		const brokenEnv = envWithDb({
			prepare: () => {
				throw new Error("d1 is down");
			},
		});
		const res = await createApp().request("/healthz", {}, brokenEnv);
		expect(res.status).toBe(503);
		await expect(res.json()).resolves.toEqual({ status: "degraded" });
		const line = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
		expect(line).toMatchObject({ level: "error", msg: "health.d1_failed" });
		expect(typeof line.request_id).toBe("string");
	});

	it("GET /healthz returns 503 within the timeout when D1 hangs", async () => {
		const hangingEnv = envWithDb({
			prepare: () => ({ first: () => new Promise(() => {}) }),
		});
		const started = Date.now();
		const res = await createApp({ healthTimeoutMs: 50 }).request(
			"/healthz",
			{},
			hangingEnv,
		);
		expect(res.status).toBe(503);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("unknown routes return 404 JSON", async () => {
		const res = await createApp().request("/no-such-route", {}, env);
		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "not_found" });
	});

	it("thrown errors return 500 without leaking the message, logged with the same request_id", async () => {
		const app = createApp();
		app.get("/boom", () => {
			throw new Error("super-secret-boom-message");
		});
		const res = await app.request(
			"/boom",
			{ headers: { "cf-ray": "ray-123" } },
			env,
		);
		expect(res.status).toBe(500);
		const text = await res.text();
		expect(text).not.toContain("super-secret-boom-message");
		expect(text).not.toContain("at ");
		expect(JSON.parse(text)).toEqual({
			error: "internal_error",
			request_id: "ray-123",
		});
		const line = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
		expect(line).toMatchObject({
			msg: "http.unhandled_error",
			request_id: "ray-123",
		});
	});

	it("exposes fixed test secret keys", () => {
		expect(env.SECRETS_KEY).toBe(
			"ERERERERERERERERERERERERERERERERERERERERERE=",
		);
		expect(env.SECRETS_KEY_PREVIOUS).toBe(
			"IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
		);
	});

	it("still answers unknown /api paths with the JSON 404 (run_worker_first)", async () => {
		const res = await createApp().request(
			"https://hookflare.example.com/api/nope",
			{},
			env,
		);
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");
	});
});
