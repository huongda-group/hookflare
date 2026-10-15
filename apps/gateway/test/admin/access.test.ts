import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessKeyCache } from "../../src/admin/auth/access";
import { createApp } from "../../src/app";
import { auditLogs, users } from "../../src/core/db/schema";
import type { Deps } from "../../src/deps";
import { accessKeys, adminApp, uniqueEmail } from "../helpers/admin";
import { testDeps } from "../helpers/deps";
import { ACCESS_TEST, testEnv } from "../helpers/env";

async function call(
	deps: Deps,
	jwksFetch: typeof fetch,
	headers: Record<string, string> = {},
	host = "https://hookflare.example.com",
) {
	const app = createApp({ createDeps: () => deps, accessFetch: jwksFetch });
	return app.request(`${host}/api/admin/v1/projects`, { headers }, deps.env);
}

describe("Access middleware", () => {
	beforeEach(() => {
		clearAccessKeyCache();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("accepts a valid token from a listed email (case-insensitive)", async () => {
		const { jwksFetch, sign } = await accessKeys();
		const deps = testDeps({
			env: testEnv({
				BOOTSTRAP_ADMIN_EMAILS: " other@example.com , ADMIN@example.com",
			}),
		});
		const res = await call(deps, jwksFetch, {
			"cf-access-jwt-assertion": await sign({ email: "Admin@Example.com" }),
		});
		expect(res.status).toBe(200);
	});

	it("returns 401 without a token", async () => {
		const { jwksFetch } = await accessKeys();
		const res = await call(testDeps(), jwksFetch);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "unauthorized" });
	});

	it.each([
		["wrong aud", { aud: "other" }, {}],
		["wrong iss", { iss: "https://evil.cloudflareaccess.com" }, {}],
		["expired", {}, { expiresIn: "-5m" }],
	])("returns 401 for %s", async (_label, claims, opts) => {
		const { jwksFetch, sign } = await accessKeys();
		const res = await call(testDeps(), jwksFetch, {
			"cf-access-jwt-assertion": await sign(claims, opts),
		});
		expect(res.status).toBe(401);
	});

	it("refetches the key set once for an unknown kid", async () => {
		const { jwksFetch, sign } = await accessKeys();
		const deps = testDeps();
		expect(
			(await call(deps, jwksFetch, { "cf-access-jwt-assertion": await sign() }))
				.status,
		).toBe(200);
		const before = jwksFetch.calls;
		expect(
			(
				await call(deps, jwksFetch, {
					"cf-access-jwt-assertion": await sign({}, { kid: "rotated" }),
				})
			).status,
		).toBe(401);
		expect(
			(
				await call(deps, jwksFetch, {
					"cf-access-jwt-assertion": await sign({}, { kid: "rotated" }),
				})
			).status,
		).toBe(401);
		expect(jwksFetch.calls - before).toBe(1);
	});

	it.each([
		["a non-listed email", { email: "intruder@example.com" }],
		["a service token (no email)", { email: undefined, common_name: "svc" }],
	])("returns 403 for %s", async (_label, claims) => {
		const { jwksFetch, sign } = await accessKeys();
		const res = await call(testDeps(), jwksFetch, {
			"cf-access-jwt-assertion": await sign(claims),
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "forbidden" });
	});

	it("fails closed when Access is not configured", async () => {
		const { jwksFetch, sign } = await accessKeys();
		const deps = testDeps({ env: testEnv({ ACCESS_AUD: "" }) });
		const res = await call(deps, jwksFetch, {
			"cf-access-jwt-assertion": await sign(),
		});
		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ error: "internal_error" });
	});

	it("applies the dev bypass only on localhost", async () => {
		const { jwksFetch } = await accessKeys();
		const deps = testDeps({
			env: testEnv({
				ACCESS_TEAM_DOMAIN: "",
				ACCESS_AUD: "",
				ACCESS_DEV_EMAIL: ACCESS_TEST.admin,
			}),
		});
		expect(
			(await call(deps, jwksFetch, {}, "http://localhost:8787")).status,
		).toBe(200);
		expect(
			(await call(deps, jwksFetch, {}, "http://127.0.0.1:8787")).status,
		).toBe(200);
		expect(
			(await call(deps, jwksFetch, {}, "https://hookflare.example.com")).status,
		).toBe(500);
	});

	it("still requires the dev email to be listed", async () => {
		const { jwksFetch } = await accessKeys();
		const deps = testDeps({
			env: testEnv({ ACCESS_DEV_EMAIL: "someone@example.com" }),
		});
		expect(
			(await call(deps, jwksFetch, {}, "http://localhost:8787")).status,
		).toBe(403);
	});

	it("bootstraps a listed email once and audits it", async () => {
		const email = uniqueEmail("boot");
		const deps = testDeps({ env: testEnv({ BOOTSTRAP_ADMIN_EMAILS: email }) });
		const api = await adminApp(deps, { email });
		expect((await api.request("GET", "/me")).status).toBe(200);
		expect((await api.request("GET", "/me")).status).toBe(200);
		const [row] = await deps.db
			.select()
			.from(users)
			.where(eq(users.email, email));
		expect(row.role).toBe("admin");
		const audits = await deps.db
			.select()
			.from(auditLogs)
			.where(eq(auditLogs.resourceId, email));
		expect(audits.map((a) => [a.action, a.actorEmail])).toEqual([
			["user.bootstrapped", email],
		]);
	});

	it("audits a bootstrap once when the first requests race", async () => {
		const email = uniqueEmail("boot");
		const deps = testDeps({ env: testEnv({ BOOTSTRAP_ADMIN_EMAILS: email }) });
		const api = await adminApp(deps, { email });
		const statuses = await Promise.all(
			[1, 2, 3].map(async () => (await api.request("GET", "/me")).status),
		);
		expect(statuses).toEqual([200, 200, 200]);
		const audits = await deps.db
			.select()
			.from(auditLogs)
			.where(eq(auditLogs.resourceId, email));
		expect(audits).toHaveLength(1);
	});

	it("does not re-bootstrap a disabled bootstrap admin", async () => {
		const email = uniqueEmail("boot");
		const deps = testDeps({ env: testEnv({ BOOTSTRAP_ADMIN_EMAILS: email }) });
		await deps.db.insert(users).values({
			email,
			role: "admin",
			createdAt: 1,
			updatedAt: 1,
			disabledAt: 1,
		});
		const api = await adminApp(deps, { email });
		const res = await api.request("GET", "/me");
		expect(res.status).toBe(403);
		const [row] = await deps.db
			.select()
			.from(users)
			.where(eq(users.email, email));
		expect(row.disabledAt).toBe(1);
	});

	it("lets a stored user in without the bootstrap list", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "viewer" });
		const res = await api.request("GET", "/me");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			email: api.email,
			role: "viewer",
			permissions: ["events.read"],
		});
	});

	it("rejects a disabled user immediately", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "operator" });
		await deps.db
			.update(users)
			.set({ disabledAt: deps.now() })
			.where(eq(users.email, api.email));
		const res = await api.request("GET", "/me");
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "forbidden" });
	});
});
