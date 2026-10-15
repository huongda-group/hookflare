import type { Page, User } from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { clearAccessKeyCache } from "../../src/admin/auth/access";
import { users } from "../../src/core/db/schema";
import { adminApp, auditRows, uniqueEmail } from "../helpers/admin";
import { testDeps } from "../helpers/deps";

beforeEach(() => {
	// Each adminApp mints fresh keys under the same kid.
	clearAccessKeyCache();
});

/** Every test starts from migrations, so the only admin is whoever we create. */
async function soleAdmin(deps: ReturnType<typeof testDeps>) {
	const api = await adminApp(deps, { role: "admin" });
	await deps.db.delete(users).where(eq(users.role, "admin"));
	await deps.db.insert(users).values({
		email: api.email,
		role: "admin",
		createdAt: deps.now(),
		updatedAt: deps.now(),
	});
	return api;
}

describe("/users", () => {
	it("creates a user, lowercases the email, and audits it", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const email = uniqueEmail("ops");
		const res = await api.request("POST", "/users", {
			email: email.toUpperCase(),
			role: "operator",
			reason: "on-call",
		});
		expect(res.status).toBe(201);
		expect(await res.json<User>()).toMatchObject({
			email,
			role: "operator",
			disabled_at: null,
		});
		const [audit] = await auditRows(deps, email);
		expect(audit).toMatchObject({ action: "user.created", reason: "on-call" });
		const dup = await api.request("POST", "/users", { email, role: "viewer" });
		expect(dup.status).toBe(409);
		expect(await dup.json()).toEqual({ error: "user_exists" });
	});

	it("matches user emails case-insensitively", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const email = uniqueEmail("mixed");
		await api.request("POST", "/users", { email, role: "viewer" });
		const res = await api.request(
			"PATCH",
			`/users/${encodeURIComponent(email.toUpperCase())}`,
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
		clearAccessKeyCache(); // second app minted fresh keys under the same kid
		const target = await adminApp(deps, { role: "viewer" });
		// The two apps hold different keys: reset the shared key cache
		// before each request so it rebuilds from the requesting app.
		const req = (
			client: typeof api,
			method: string,
			path: string,
			body?: unknown,
		) => {
			clearAccessKeyCache();
			return client.request(method, path, body);
		};
		await req(api, "PATCH", `/users/${target.email}`, { role: "operator" });
		await req(api, "PATCH", `/users/${target.email}`, { disabled: true });
		expect((await req(target, "GET", "/me")).status).toBe(403); // immediate
		await req(api, "PATCH", `/users/${target.email}`, { disabled: false });
		expect((await req(target, "GET", "/me")).status).toBe(200);
		expect((await auditRows(deps, target.email)).map((a) => a.action)).toEqual([
			"user.role_changed",
			"user.disabled",
			"user.enabled",
		]);
	});

	it("refuses to demote or disable the last active admin", async () => {
		const deps = testDeps();
		const api = await soleAdmin(deps);
		const other = uniqueEmail("admin2");
		await api.request("POST", "/users", { email: other, role: "admin" });
		await api.request("PATCH", `/users/${other}`, { disabled: true });
		const res = await api.request("PATCH", `/users/${api.email}`, {
			role: "viewer",
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "last_admin" });
		const [row] = await deps.db
			.select()
			.from(users)
			.where(eq(users.email, api.email));
		expect(row.role).toBe("admin");
		expect(
			(await auditRows(deps, api.email)).map((a) => a.action),
		).not.toContain("user.role_changed");
	});

	it("refuses to let an admin disable themselves", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const res = await api.request("PATCH", `/users/${api.email}`, {
			disabled: true,
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "self_disable" });
	});

	it("lists users by email with a cursor and answers 404 for an unknown user", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		for (const p of ["a", "b", "c"]) {
			await api.request("POST", "/users", {
				email: uniqueEmail(`list-${p}`),
				role: "viewer",
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
			all.push(...page.data.map((u) => u.email));
			cursor = page.next_cursor;
		} while (cursor);
		expect(all).toEqual([...all].sort());
		expect(
			(
				await api.request("PATCH", `/users/${uniqueEmail("ghost")}`, {
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
