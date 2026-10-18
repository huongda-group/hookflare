import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../../src/admin/auth/password";
import { randomToken, sha256Hex } from "../../../src/admin/auth/secrets";
import { SESSION_COOKIE } from "../../../src/admin/auth/session";
import { createApp } from "../../../src/app";
import { auditLogs, users } from "../../../src/core/db/schema";
import { insertSessionStmt } from "../../../src/core/db/sessions";
import { getUser } from "../../../src/core/db/users";
import type { Deps } from "../../../src/deps";
import { adminApp, uniqueUsername } from "../../helpers/admin";
import { testDeps } from "../../helpers/deps";

const ORIGIN = "https://hookflare.example.com";
const ADMIN_API = `${ORIGIN}/api/admin/v1`;
const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "rotated-horse-battery";

/** Replaces the dummy hash `adminApp` seeds with a real one we can type. */
async function setPassword(deps: Deps, username: string, password: string) {
	await deps.db
		.update(users)
		.set({ passwordHash: await hashPassword(password) })
		.where(eq(users.username, username));
}

/** A bare request carrying a raw session cookie, bypassing `adminApp`. */
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
		// Two live sessions for the same user, both cookie-authenticated.
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

		// The session that made the change survives; the other one is gone.
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

		// A live cookie session for the same user must be dropped: a token
		// caller has no `sessionIdHash`, so the delete has no exception.
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
});
