import type { ApiToken, CreatedApiToken } from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../../src/admin/auth/secrets";
import { createApp } from "../../../src/app";
import { apiTokens } from "../../../src/core/db/schema";
import type { Deps } from "../../../src/deps";
import { adminApp, auditRows, uniqueUsername } from "../../helpers/admin";
import { testDeps } from "../../helpers/deps";

const ORIGIN = "https://hookflare.example.com";
const ADMIN_API = `${ORIGIN}/api/admin/v1`;
const DAY_MS = 86_400_000;
const PASSWORD = "correct-horse-battery";

/** A bare request carrying a created Bearer token. */
function withBearer(deps: Deps, token: string, path = "/me") {
	return createApp({ createDeps: () => deps }).request(
		`${ADMIN_API}${path}`,
		{
			headers: { authorization: `Bearer ${token}` },
		},
		deps.env,
	);
}

/** Creates a user and returns the admin app plus the new username. */
async function withUser(deps: Deps, role: "viewer" | "operator" = "viewer") {
	const api = await adminApp(deps, { role: "admin" });
	const username = uniqueUsername("tok");
	await api.request("POST", "/users", { username, role, password: PASSWORD });
	return { api, username };
}

describe("/users/:username/tokens", () => {
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

		// Only the SHA-256 hex is stored, never the plaintext.
		const [row] = await deps.db
			.select()
			.from(apiTokens)
			.where(eq(apiTokens.id, body.id));
		expect(row.tokenHash).toBe(await sha256Hex(body.token));
		expect(row.tokenHash).not.toBe(body.token);

		// The token authenticates as its user.
		expect((await withBearer(deps, body.token)).status).toBe(200);

		// The list keeps the metadata but never the secret or its hash.
		const list = await api.request("GET", `/users/${username}/tokens`);
		expect(list.status).toBe(200);
		const text = await list.text();
		expect(text).not.toContain(body.token);
		expect(text).not.toContain("token_hash");
		const page = JSON.parse(text) as { data: ApiToken[] };
		expect(page.data).toHaveLength(1);
		expect(page.data[0]).toMatchObject({ id: body.id, name: "ci" });

		// The create is audited without the secret.
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
		// Still active: the wrong-owner revoke changed nothing.
		expect((await withBearer(deps, token)).status).toBe(200);
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
});
