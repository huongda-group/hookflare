import type { Page, User } from "@hookflare/shared";
import { and, eq, ne } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { users } from "../../src/core/db/schema";
import { adminApp, auditRows, uniqueUsername } from "../helpers/admin";
import { testDeps } from "../helpers/deps";

/** A valid initial password (>= 12 chars); POST /users requires one. */
const PASSWORD = "correct-horse-battery";

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
		// Disabling takes effect on the very next request: the user row is read
		// per request, so the session is rejected (401).
		expect((await target.request("GET", "/me")).status).toBe(401);
		await api.request("PATCH", `/users/${target.username}`, {
			disabled: false,
		});
		expect((await target.request("GET", "/me")).status).toBe(200);
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
});
