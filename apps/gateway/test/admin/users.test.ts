import type { Page, User } from "@hookflare/shared";
import { and, eq, ne } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { verifyPassword } from "../../src/admin/auth/password";
import { createApp } from "../../src/app";
import { sessions, users } from "../../src/core/db/schema";
import { getUser } from "../../src/core/db/users";
import { adminApp, auditRows, uniqueUsername } from "../helpers/admin";
import { testDeps } from "../helpers/deps";

/** A valid initial password (>= 12 chars); POST /users requires one. */
const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "rotated-horse-battery";
const ORIGIN = "https://hookflare.example.com";

/** Every test starts from migrations, so the only admin is whoever we create. */
async function soleAdmin(deps: ReturnType<typeof testDeps>) {
	const api = await adminApp(deps, { role: "admin" });
	// Drop every other admin, keeping this app's row (and session) intact.
	await deps.db
		.delete(users)
		.where(and(eq(users.role, "admin"), ne(users.username, api.username)));
	return api;
}

describe("/users", () => {
	it("creates a user, lowercases the username, and audits it", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const username = uniqueUsername("ops");
		const res = await api.request("POST", "/users", {
			username: username.toUpperCase(),
			role: "operator",
			password: PASSWORD,
			reason: "on-call",
		});
		expect(res.status).toBe(201);
		expect(await res.json<User>()).toMatchObject({
			username,
			role: "operator",
			disabled_at: null,
			has_password: true,
		});
		const [audit] = await auditRows(deps, username);
		expect(audit).toMatchObject({ action: "user.created", reason: "on-call" });
		const dup = await api.request("POST", "/users", {
			username,
			role: "viewer",
			password: PASSWORD,
		});
		expect(dup.status).toBe(409);
		expect(await dup.json()).toEqual({ error: "user_exists" });
	});

	it("matches user usernames case-insensitively", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const username = uniqueUsername("mixed");
		await api.request("POST", "/users", {
			username,
			role: "viewer",
			password: PASSWORD,
		});
		const res = await api.request(
			"PATCH",
			`/users/${encodeURIComponent(username.toUpperCase())}`,
			{
				role: "operator",
			},
		);
		expect(res.status).toBe(200);
		expect((await res.json<User>()).role).toBe("operator");
	});

	it("changes role, disables, and re-enables with one audit row each", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const target = await adminApp(deps, { role: "viewer" });
		await api.request("PATCH", `/users/${target.username}`, {
			role: "operator",
		});
		await api.request("PATCH", `/users/${target.username}`, {
			disabled: true,
		});
		// Disabling deletes the user's sessions in the same batch, so the next
		// request is rejected (401).
		expect((await target.request("GET", "/me")).status).toBe(401);
		await api.request("PATCH", `/users/${target.username}`, {
			disabled: false,
		});
		// Re-enabling does not resurrect a deleted session; the row is active.
		const [row] = await deps.db
			.select()
			.from(users)
			.where(eq(users.username, target.username));
		expect(row.disabledAt).toBeNull();
		expect(
			(await auditRows(deps, target.username)).map((a) => a.action),
		).toEqual(["user.role_changed", "user.disabled", "user.enabled"]);
	});

	it("treats a PATCH that changes nothing as a no-op", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const username = uniqueUsername("viewer");
		await deps.db
			.insert(users)
			.values({ username, role: "viewer", createdAt: 1, updatedAt: 1 });
		for (const body of [{ role: "viewer" }, { disabled: false }]) {
			const res = await api.request("PATCH", `/users/${username}`, body);
			expect(res.status).toBe(200);
			expect((await res.json<User>()).updated_at).toBe(1);
		}
		expect(await auditRows(deps, username)).toEqual([]);
	});

	it("refuses to demote or disable the last active admin", async () => {
		const deps = testDeps();
		const api = await soleAdmin(deps);
		const other = uniqueUsername("admin2");
		await api.request("POST", "/users", {
			username: other,
			role: "admin",
			password: PASSWORD,
		});
		await api.request("PATCH", `/users/${other}`, { disabled: true });
		const res = await api.request("PATCH", `/users/${api.username}`, {
			role: "viewer",
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "last_admin" });
		const [row] = await deps.db
			.select()
			.from(users)
			.where(eq(users.username, api.username));
		expect(row.role).toBe("admin");
		expect(
			(await auditRows(deps, api.username)).map((a) => a.action),
		).not.toContain("user.role_changed");
	});

	it("refuses to let an admin disable themselves", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const res = await api.request("PATCH", `/users/${api.username}`, {
			disabled: true,
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "self_disable" });
	});

	it("answers 404, not 500, for a username containing a percent sign", async () => {
		const api = await adminApp(testDeps(), { role: "admin" });
		const res = await api.request(
			"PATCH",
			`/users/${encodeURIComponent("100%off@example.com")}`,
			{ role: "viewer" },
		);
		expect(res.status).toBe(404);
	});

	it("lists users by username with a cursor and answers 404 for an unknown user", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		for (const p of ["a", "b", "c"]) {
			await api.request("POST", "/users", {
				username: uniqueUsername(`list-${p}`),
				role: "viewer",
				password: PASSWORD,
			});
		}
		const all: string[] = [];
		let cursor: string | null = null;
		do {
			const page: Page<User> = await (
				await api.request(
					"GET",
					`/users?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
				)
			).json();
			all.push(...page.data.map((u) => u.username));
			cursor = page.next_cursor;
		} while (cursor);
		expect(all).toEqual([...all].sort());
		expect(
			(
				await api.request("PATCH", `/users/${uniqueUsername("ghost")}`, {
					role: "viewer",
				})
			).status,
		).toBe(404);
	});

	it("is admin only", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "operator" });
		expect((await api.request("GET", "/users")).status).toBe(403);
	});

	it("hashes the password so the new user can log in", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const username = uniqueUsername("login");
		const created = await api.request("POST", "/users", {
			username,
			role: "operator",
			password: PASSWORD,
		});
		expect(created.status).toBe(201);
		expect(await created.json<User>()).toMatchObject({
			username,
			has_password: true,
		});
		const row = await getUser(deps.db, username);
		expect(await verifyPassword(PASSWORD, row?.passwordHash ?? null)).toBe(
			true,
		);

		const login = await createApp({ createDeps: () => deps }).request(
			`${ORIGIN}/api/admin/v1/auth/login`,
			{
				method: "POST",
				headers: { origin: ORIGIN, "content-type": "application/json" },
				body: JSON.stringify({ username, password: PASSWORD }),
			},
			deps.env,
		);
		expect(login.status).toBe(204);
	});

	it("rejects a password equal to the new username", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const res = await api.request("POST", "/users", {
			username: "admintwelve1",
			role: "viewer",
			password: "admintwelve1",
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "password_equals_username" });
		expect(await getUser(deps.db, "admintwelve1")).toBeUndefined();
	});

	it("rejects a username that fails the new rule", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const res = await api.request("POST", "/users", {
			username: "ab",
			role: "viewer",
			password: PASSWORD,
		});
		expect(res.status).toBe(400);
	});

	it("still accepts a legacy svc: key as a path param", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		await deps.db.insert(users).values({
			username: "svc:bot",
			role: "viewer",
			createdAt: 1,
			updatedAt: 1,
			disabledAt: deps.now(),
		});
		const res = await api.request(
			"PATCH",
			`/users/${encodeURIComponent("svc:bot")}`,
			{ role: "operator" },
		);
		expect(res.status).toBe(200);
		expect((await res.json<User>()).role).toBe("operator");
	});

	it("resets a password, drops the target's sessions, and audits no secret", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const target = await adminApp(deps, { role: "viewer" });
		expect((await target.request("GET", "/me")).status).toBe(200);

		const res = await api.request(
			"POST",
			`/users/${target.username}/password`,
			{
				password: NEW_PASSWORD,
				reason: "lost device",
			},
		);
		expect(res.status).toBe(204);
		// The only reason this 401s is that the session row was deleted.
		expect((await target.request("GET", "/me")).status).toBe(401);

		const [audit] = (await auditRows(deps, target.username)).filter(
			(a) => a.action === "user.password_reset",
		);
		expect(audit).toMatchObject({
			action: "user.password_reset",
			reason: "lost device",
		});
		const diff = JSON.stringify(audit.diffJson);
		expect(diff).not.toContain("password");
		expect(diff).not.toContain("hash");

		const row = await getUser(deps.db, target.username);
		expect(row?.passwordChangedAt).not.toBeNull();
		expect(await verifyPassword(NEW_PASSWORD, row?.passwordHash ?? null)).toBe(
			true,
		);
	});

	it("rejects a reset password equal to the target username", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const target = await adminApp(deps, {
			username: "admintwelve1",
			role: "viewer",
		});
		const res = await api.request(
			"POST",
			`/users/${target.username}/password`,
			{
				password: "admintwelve1",
			},
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "password_equals_username" });
	});

	it("answers 404 when resetting the password of an unknown user", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const res = await api.request(
			"POST",
			`/users/${uniqueUsername("ghost")}/password`,
			{ password: NEW_PASSWORD },
		);
		expect(res.status).toBe(404);
	});

	it("deletes the user's session rows in the same batch as a disable", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const target = await adminApp(deps, { role: "viewer" });
		expect(
			await deps.db
				.select()
				.from(sessions)
				.where(eq(sessions.username, target.username)),
		).toHaveLength(1);

		const res = await api.request("PATCH", `/users/${target.username}`, {
			disabled: true,
		});
		expect(res.status).toBe(200);
		expect(
			await deps.db
				.select()
				.from(sessions)
				.where(eq(sessions.username, target.username)),
		).toEqual([]);
	});
});
