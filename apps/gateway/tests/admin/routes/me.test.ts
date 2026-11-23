import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "../../../src/admin/auth/password";
import { randomToken, sha256Hex } from "../../../src/admin/auth/secrets";
import { SESSION_COOKIE } from "../../../src/admin/auth/session";
import { meRoutes } from "../../../src/admin/routes/me";
import type { AppBindings } from "../../../src/app";
import { createApp } from "../../../src/app";
import { auditLogs, users } from "../../../src/core/db/schema";
import { insertSessionStmt } from "../../../src/core/db/sessions";
import { getUser } from "../../../src/core/db/users";
import type { Deps } from "../../../src/deps";
import {
	adminApp,
	seedAdminProject,
	uniqueUsername,
} from "../../helpers/admin";
import { testDeps } from "../../helpers/deps";
import { denyAllLimiter, testEnv } from "../../helpers/env";

const ORIGIN = "https://hookflare.example.com";
const ADMIN_API = `${ORIGIN}/api/admin/v1`;
const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "rotated-horse-battery";

async function setPassword(deps: Deps, username: string, password: string) {
	await deps.db
		.update(users)
		.set({ passwordHash: await hashPassword(password) })
		.where(eq(users.username, username));
}

function withCookie(deps: Deps, token: string, method = "GET", path = "/me") {
	return createApp({ createDeps: () => deps }).request(
		`${ADMIN_API}${path}`,
		{
			method,
			headers: {
				cookie: `${SESSION_COOKIE}=${token}`,
				origin: ORIGIN,
			},
		},
		deps.env,
	);
}

describe("GET /me", () => {
	it("returns the current actor's Me", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const res = await api.request("GET", "/me");
		expect(res.status).toBe(200);
		const body = await res.json<{ username: string; role: string }>();
		expect(body).toMatchObject({ username: api.username, role: "admin" });
		expect(Array.isArray((body as { permissions?: unknown }).permissions)).toBe(
			true,
		);
	});
});

describe("POST /me/password", () => {
	beforeEach(seedAdminProject);
	it("rejects a wrong current password with 401 and writes nothing", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		await setPassword(deps, api.username, PASSWORD);
		const before = await getUser(deps.db, api.username);

		const res = await api.request("POST", "/me/password", {
			current_password: "not-the-password",
			new_password: NEW_PASSWORD,
		});
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "wrong_password" });

		const after = await getUser(deps.db, api.username);
		expect(after?.passwordHash).toBe(before?.passwordHash);
		expect(after?.passwordChangedAt).toBe(before?.passwordChangedAt);
		expect(
			await deps.db
				.select()
				.from(auditLogs)
				.where(eq(auditLogs.action, "user.password_changed")),
		).toEqual([]);
	});

	it("keeps the current session and drops the callers other sessions", async () => {
		const deps = testDeps();
		const username = uniqueUsername("pw");
		const a = await adminApp(deps, { username, role: "admin" });
		const b = await adminApp(deps, { username, role: "admin" });
		await setPassword(deps, username, PASSWORD);
		expect((await a.request("GET", "/me")).status).toBe(200);
		expect((await b.request("GET", "/me")).status).toBe(200);

		const res = await a.request("POST", "/me/password", {
			current_password: PASSWORD,
			new_password: NEW_PASSWORD,
		});
		expect(res.status).toBe(204);

		expect((await a.request("GET", "/me")).status).toBe(200);
		expect((await b.request("GET", "/me")).status).toBe(401);

		const row = await getUser(deps.db, username);
		expect(row?.passwordChangedAt).not.toBeNull();
		expect(await verifyPassword(NEW_PASSWORD, row?.passwordHash ?? null)).toBe(
			true,
		);
		expect(await verifyPassword(PASSWORD, row?.passwordHash ?? null)).toBe(
			false,
		);

		const [audit] = await deps.db
			.select()
			.from(auditLogs)
			.where(eq(auditLogs.action, "user.password_changed"));
		expect(audit).toMatchObject({
			resourceType: "user",
			resourceId: username,
		});
		const diff = JSON.stringify(audit.diffJson);
		expect(diff).not.toContain("password");
		expect(diff).not.toContain("hash");
	});

	it("deletes every session of the caller when authenticated by a token", async () => {
		const deps = testDeps();
		const username = uniqueUsername("tok-user");
		const tokenApi = await adminApp(deps, { username, via: "token" });
		await setPassword(deps, username, PASSWORD);

		const sessionToken = randomToken();
		await insertSessionStmt(deps.db, {
			idHash: await sha256Hex(sessionToken),
			username,
			now: deps.now(),
		});
		expect((await withCookie(deps, sessionToken)).status).toBe(200);

		const res = await tokenApi.request("POST", "/me/password", {
			current_password: PASSWORD,
			new_password: NEW_PASSWORD,
		});
		expect(res.status).toBe(204);
		expect((await withCookie(deps, sessionToken)).status).toBe(401);
	});

	it("rejects a new password equal to the username", async () => {
		const deps = testDeps();
		const username = "admintwelve1";
		const api = await adminApp(deps, { username, role: "admin" });
		await setPassword(deps, username, PASSWORD);
		const res = await api.request("POST", "/me/password", {
			current_password: PASSWORD,
			new_password: username,
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "password_equals_username" });
	});

	it("rate-limits per username before PBKDF2 and returns 429 when rejected", async () => {
		const keys: string[] = [];
		const limiter = {
			limit: async ({ key }: { key: string }) => {
				keys.push(key);
				return { success: true };
			},
		} as unknown as RateLimit;
		const deps = testDeps({ env: testEnv({ LOGIN_LIMITER: limiter }) });
		const api = await adminApp(deps, { role: "viewer" });
		await setPassword(deps, api.username, PASSWORD);
		const ok = await api.request("POST", "/me/password", {
			current_password: "not-the-password",
			new_password: NEW_PASSWORD,
		});
		expect(ok.status).toBe(401);
		expect(keys).toEqual([`password:${api.username}`]);

		const denied = testDeps({
			env: testEnv({ LOGIN_LIMITER: denyAllLimiter }),
		});
		const blocked = await adminApp(denied, { role: "viewer" });
		await setPassword(denied, blocked.username, PASSWORD);
		const deriveSpy = vi.spyOn(crypto.subtle, "deriveBits");
		try {
			const res = await blocked.request("POST", "/me/password", {
				current_password: PASSWORD,
				new_password: NEW_PASSWORD,
			});
			expect(res.status).toBe(429);
			expect(await res.json()).toEqual({ error: "too_many_attempts" });
			expect(deriveSpy).not.toHaveBeenCalled();
		} finally {
			deriveSpy.mockRestore();
		}
		const row = await getUser(denied.db, blocked.username);
		expect(await verifyPassword(PASSWORD, row?.passwordHash ?? null)).toBe(
			true,
		);
	});

	it("requires authentication", async () => {
		const deps = testDeps();
		const res = await createApp({ createDeps: () => deps }).request(
			`${ADMIN_API}/me/password`,
			{
				method: "POST",
				headers: { origin: ORIGIN, "content-type": "application/json" },
				body: JSON.stringify({
					current_password: PASSWORD,
					new_password: NEW_PASSWORD,
				}),
			},
			deps.env,
		);
		expect(res.status).toBe(401);
	});
	it("rejects an invalid body with 400 and keeps the password", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "viewer" });
		await setPassword(deps, api.username, PASSWORD);
		const res = await api.request("POST", "/me/password", {
			current_password: PASSWORD,
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "invalid_request" });
		const row = await getUser(deps.db, api.username);
		expect(await verifyPassword(PASSWORD, row?.passwordHash ?? null)).toBe(
			true,
		);
	});
});

describe("me routes without the auth middleware", () => {
	it("fail closed with 403 when no actor is set", async () => {
		const deps = testDeps();
		const app = new Hono<AppBindings>()
			.use(async (c, next) => {
				c.set("deps", deps);
				await next();
			})
			.route("/me", meRoutes());
		const me = await app.request("/me");
		expect(me.status).toBe(403);
		expect(await me.json()).toEqual({ error: "forbidden" });
		const pw = await app.request("/me/password", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				current_password: PASSWORD,
				new_password: NEW_PASSWORD,
			}),
		});
		expect(pw.status).toBe(403);
		expect(await pw.json()).toEqual({ error: "forbidden" });
	});
});
