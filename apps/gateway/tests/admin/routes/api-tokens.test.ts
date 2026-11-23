import type { ApiToken, CreatedApiToken } from "@hookflare/shared";
import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../../src/admin/auth/secrets";
import { apiTokenRoutes } from "../../../src/admin/routes/api-tokens";
import type { AppBindings } from "../../../src/app";
import { createApp } from "../../../src/app";
import { apiTokens, users } from "../../../src/core/db/schema";
import type { Deps } from "../../../src/deps";
import {
	adminApp,
	auditRows,
	beforeNextBatch,
	seedAdminProject,
	uniqueUsername,
} from "../../helpers/admin";
import { testDeps } from "../../helpers/deps";

const ORIGIN = "https://hookflare.example.com";
const ADMIN_API = `${ORIGIN}/api/admin/v1`;
const DAY_MS = 86_400_000;
const PASSWORD = "correct-horse-battery";

function withBearer(deps: Deps, token: string, path = "/me") {
	return createApp({ createDeps: () => deps }).request(
		`${ADMIN_API}${path}`,
		{
			headers: { authorization: `Bearer ${token}` },
		},
		deps.env,
	);
}

async function withUser(deps: Deps, role: "viewer" | "operator" = "viewer") {
	const api = await adminApp(deps, { role: "admin" });
	const username = uniqueUsername("tok");
	await api.request("POST", "/users", { username, role, password: PASSWORD });
	return { api, username };
}

describe("/users/:username/tokens", () => {
	beforeEach(seedAdminProject);
	it("returns the plaintext token once and never lists it", async () => {
		const deps = testDeps();
		const { api, username } = await withUser(deps);
		const created = await api.request("POST", `/users/${username}/tokens`, {
			name: "ci",
			expires_in_days: 30,
			reason: "automation",
		});
		expect(created.status).toBe(201);
		const body = await created.json<CreatedApiToken>();
		expect(body).toMatchObject({
			username,
			name: "ci",
			revoked_at: null,
			last_used_at: null,
		});
		expect(body.token).toMatch(/^hf_/);
		expect(body.expires_at).toBe(body.created_at + 30 * DAY_MS);

		const [row] = await deps.db
			.select()
			.from(apiTokens)
			.where(eq(apiTokens.id, body.id));
		expect(row.tokenHash).toBe(await sha256Hex(body.token));
		expect(row.tokenHash).not.toBe(body.token);

		expect((await withBearer(deps, body.token)).status).toBe(200);

		const list = await api.request("GET", `/users/${username}/tokens`);
		expect(list.status).toBe(200);
		const text = await list.text();
		expect(text).not.toContain(body.token);
		expect(text).not.toContain("token_hash");
		const page = JSON.parse(text) as { data: ApiToken[] };
		expect(page.data).toHaveLength(1);
		expect(page.data[0]).toMatchObject({ id: body.id, name: "ci" });

		const createAudit = (await auditRows(deps, body.id)).find(
			(a) => a.action === "api_token.created",
		);
		expect(createAudit).toBeDefined();
		const diff = JSON.stringify(createAudit?.diffJson);
		expect(diff).not.toContain(body.token);
		expect(diff).not.toContain("token_hash");
	});

	it("revokes a token: it stops working and a second revoke is 404", async () => {
		const deps = testDeps();
		const { api, username } = await withUser(deps);
		const { token, id } = await (
			await api.request("POST", `/users/${username}/tokens`, { name: "ci" })
		).json<CreatedApiToken>();
		expect((await withBearer(deps, token)).status).toBe(200);

		const revoke = await api.request(
			"POST",
			`/users/${username}/tokens/${id}/revoke`,
		);
		expect(revoke.status).toBe(204);
		expect((await withBearer(deps, token)).status).toBe(401);

		const again = await api.request(
			"POST",
			`/users/${username}/tokens/${id}/revoke`,
		);
		expect(again.status).toBe(404);

		const revoked = (await auditRows(deps, id)).find(
			(a) => a.action === "api_token.revoked",
		);
		expect(revoked).toBeDefined();
	});

	it("forbids viewers from listing, creating, and revoking tokens", async () => {
		const deps = testDeps();
		const { api, username } = await withUser(deps);
		const { id } = await (
			await api.request("POST", `/users/${username}/tokens`, { name: "ci" })
		).json<CreatedApiToken>();
		const viewer = await adminApp(deps, { role: "viewer" });
		expect(
			(await viewer.request("GET", `/users/${username}/tokens`)).status,
		).toBe(403);
		expect(
			(
				await viewer.request("POST", `/users/${username}/tokens`, {
					name: "x",
				})
			).status,
		).toBe(403);
		expect(
			(await viewer.request("POST", `/users/${username}/tokens/${id}/revoke`))
				.status,
		).toBe(403);
	});

	it("does not revoke another user's token through this user's path", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const owner = uniqueUsername("owner");
		const other = uniqueUsername("other");
		for (const username of [owner, other]) {
			await api.request("POST", "/users", {
				username,
				role: "viewer",
				password: PASSWORD,
			});
		}
		const { id, token } = await (
			await api.request("POST", `/users/${owner}/tokens`, { name: "ci" })
		).json<CreatedApiToken>();

		const res = await api.request(
			"POST",
			`/users/${other}/tokens/${id}/revoke`,
		);
		expect(res.status).toBe(404);
		expect((await withBearer(deps, token)).status).toBe(200);
	});

	it("audits a token created for another user with the admin as actor and the owner as target", async () => {
		const deps = testDeps();
		const { api, username } = await withUser(deps);
		const { id } = await (
			await api.request("POST", `/users/${username}/tokens`, { name: "ci" })
		).json<CreatedApiToken>();
		const [audit] = await auditRows(deps, id);
		expect(audit).toMatchObject({
			action: "api_token.created",
			actor: api.username,
			resourceType: "api_token",
			resourceId: id,
			diffJson: { username, name: "ci" },
		});
	});

	it("rejects a disabled user's token while disabled, even before revocation", async () => {
		const deps = testDeps();
		const { api, username } = await withUser(deps);
		const { token } = await (
			await api.request("POST", `/users/${username}/tokens`, { name: "ci" })
		).json<CreatedApiToken>();
		await deps.db
			.update(users)
			.set({ disabledAt: deps.now() })
			.where(eq(users.username, username));
		expect((await withBearer(deps, token)).status).toBe(401);
		await deps.db
			.update(users)
			.set({ disabledAt: null })
			.where(eq(users.username, username));
		expect((await withBearer(deps, token)).status).toBe(200);
	});

	it("revokes every live token when the user is disabled and audits their IDs", async () => {
		const deps = testDeps();
		const { api, username } = await withUser(deps);
		const created: CreatedApiToken[] = [];
		for (const name of ["a", "b", "c"]) {
			created.push(
				await (
					await api.request("POST", `/users/${username}/tokens`, { name })
				).json<CreatedApiToken>(),
			);
		}
		const [a, b, c] = created;
		expect(
			(await api.request("POST", `/users/${username}/tokens/${c.id}/revoke`))
				.status,
		).toBe(204);
		const res = await api.request("PATCH", `/users/${username}`, {
			disabled: true,
			reason: "left the team",
		});
		expect(res.status).toBe(200);
		const rows = await deps.db
			.select()
			.from(apiTokens)
			.where(eq(apiTokens.username, username));
		expect(rows.every((r) => r.revokedAt !== null)).toBe(true);

		await api.request("PATCH", `/users/${username}`, { disabled: false });
		expect((await withBearer(deps, a.token)).status).toBe(401);
		expect((await withBearer(deps, b.token)).status).toBe(401);

		const bulk = (await auditRows(deps, username)).filter(
			(r) => r.action === "api_token.revoked",
		);
		expect(bulk).toHaveLength(1);
		expect(bulk[0]).toMatchObject({
			actor: api.username,
			resourceType: "user",
			resourceId: username,
			reason: "left the team",
			diffJson: { revoked_ids: [a.id, b.id].sort(), cause: "user.disabled" },
		});
	});

	it("writes no bulk revoke audit when a disabled user has no live tokens", async () => {
		const deps = testDeps();
		const { api, username } = await withUser(deps);
		const res = await api.request("PATCH", `/users/${username}`, {
			disabled: true,
		});
		expect(res.status).toBe(200);
		expect(
			(await auditRows(deps, username)).map((r) => r.action),
		).not.toContain("api_token.revoked");
	});

	it("revokes nothing when the disable is rejected as the last admin", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const target = uniqueUsername("lastadm");
		await api.request("POST", "/users", {
			username: target,
			role: "admin",
			password: PASSWORD,
		});
		await (
			await api.request("POST", `/users/${target}/tokens`, { name: "ci" })
		).json<CreatedApiToken>();
		beforeNextBatch(deps, () =>
			deps.db
				.update(users)
				.set({ disabledAt: deps.now() })
				.where(and(eq(users.role, "admin"), ne(users.username, target))),
		);
		const res = await api.request("PATCH", `/users/${target}`, {
			disabled: true,
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "last_admin" });
		const [row] = await deps.db
			.select()
			.from(apiTokens)
			.where(eq(apiTokens.username, target));
		expect(row.revokedAt).toBeNull();
		expect((await auditRows(deps, target)).map((r) => r.action)).not.toContain(
			"api_token.revoked",
		);
	});

	it("answers 404 when listing tokens of an unknown user", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const res = await api.request(
			"GET",
			`/users/${uniqueUsername("ghost")}/tokens`,
		);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "not_found" });
	});

	it("answers 404 when creating a token for an unknown user", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const res = await api.request(
			"POST",
			`/users/${uniqueUsername("ghost")}/tokens`,
			{ name: "ci" },
		);
		expect(res.status).toBe(404);
	});

	it("refuses a token for a password-less user and stores nothing", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const username = uniqueUsername("nopass");
		await deps.db.insert(users).values({
			username,
			role: "viewer",
			passwordHash: null,
			passwordChangedAt: null,
			createdAt: deps.now(),
			updatedAt: deps.now(),
			disabledAt: null,
		});
		const res = await api.request("POST", `/users/${username}/tokens`, {
			name: "ci",
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "user_has_no_password" });
		expect(
			await deps.db
				.select()
				.from(apiTokens)
				.where(eq(apiTokens.username, username)),
		).toEqual([]);
	});
	it("rejects an invalid create body with 400 and stores nothing", async () => {
		const deps = testDeps();
		const { api, username } = await withUser(deps);
		const res = await api.request("POST", `/users/${username}/tokens`, {
			name: "",
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "invalid_request" });
		expect(
			await deps.db
				.select()
				.from(apiTokens)
				.where(eq(apiTokens.username, username)),
		).toEqual([]);
	});

	it("finds no user and touches no token when mounted without a :username", async () => {
		const deps = testDeps();
		const app = new Hono<AppBindings>()
			.use(async (c, next) => {
				c.set("deps", deps);
				c.set("actor", { username: "root@example.com", role: "admin" });
				await next();
			})
			.route("/tokens", apiTokenRoutes());
		const list = await app.request("/tokens");
		expect(list.status).toBe(404);
		const created = await app.request("/tokens", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "ci" }),
		});
		expect(created.status).toBe(404);
		const revoked = await app.request("/tokens/tok_missing/revoke", {
			method: "POST",
		});
		expect(revoked.status).toBe(404);
	});
});
