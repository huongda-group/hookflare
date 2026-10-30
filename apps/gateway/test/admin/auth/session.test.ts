import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { randomToken, sha256Hex } from "../../../src/admin/auth/secrets";
import {
	clearSessionCookie,
	isSameOrigin,
	SESSION_COOKIE,
	setSessionCookie,
} from "../../../src/admin/auth/session";
import type { AppBindings } from "../../../src/app";
import { createApp } from "../../../src/app";
import {
	apiTokens,
	type Role,
	sessions,
	users,
} from "../../../src/core/db/schema";
import {
	SESSION_ABSOLUTE_MS,
	SESSION_IDLE_MS,
	SESSION_TOUCH_MS,
} from "../../../src/core/db/sessions";
import { newId } from "../../../src/core/ids";
import type { Deps } from "../../../src/deps";
import { testDeps } from "../../helpers/deps";

const T0 = 1_800_000_000_000;
const ORIGIN = "https://hookflare.example.com";
/** Only "IS NOT NULL" matters; the value is never parsed by the middleware. */
const PASSWORD_HASH = "pbkdf2-sha256$100000$c2FsdA==$aGFzaA==";

/** Storage is shared across this file, so keys are unique per test. */
function uid(prefix = "u") {
	return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function clock(start = T0) {
	let t = start;
	const deps = testDeps({ now: () => t });
	return {
		deps,
		set: (v: number) => {
			t = v;
		},
	};
}

async function seedUser(
	deps: Deps,
	username: string,
	overrides: Partial<typeof users.$inferInsert> = {},
) {
	await deps.db.insert(users).values({
		username,
		role: "admin",
		passwordHash: PASSWORD_HASH,
		passwordChangedAt: null,
		createdAt: T0,
		updatedAt: T0,
		disabledAt: null,
		...overrides,
	});
}

/** A session row plus the raw cookie token that resolves to it. */
async function cookieSession(
	deps: Deps,
	opts: {
		role?: Role;
		username?: string;
		createdAt?: number;
		lastSeenAt?: number;
		expiresAt?: number;
	} = {},
) {
	const username = opts.username ?? uid();
	await seedUser(deps, username, { role: opts.role ?? "admin" });
	const token = randomToken();
	const idHash = await sha256Hex(token);
	await deps.db.insert(sessions).values({
		idHash,
		username,
		createdAt: opts.createdAt ?? T0,
		lastSeenAt: opts.lastSeenAt ?? T0,
		expiresAt: opts.expiresAt ?? T0 + SESSION_IDLE_MS,
	});
	return { username, token, idHash };
}

/** An API token row plus the raw `hf_…` token that resolves to it. */
async function bearerToken(
	deps: Deps,
	opts: {
		role?: Role;
		username?: string;
		expiresAt?: number | null;
		revokedAt?: number | null;
		lastUsedAt?: number | null;
	} = {},
) {
	const username = opts.username ?? uid();
	await seedUser(deps, username, { role: opts.role ?? "admin" });
	const token = randomToken("hf_");
	await deps.db.insert(apiTokens).values({
		id: newId("tok", T0),
		tokenHash: await sha256Hex(token),
		username,
		name: "test",
		createdAt: T0,
		expiresAt: opts.expiresAt ?? null,
		lastUsedAt: opts.lastUsedAt ?? null,
		revokedAt: opts.revokedAt ?? null,
	});
	return { username, token };
}

function request(
	deps: Deps,
	method: string,
	path: string,
	headers: Record<string, string> = {},
	body?: unknown,
	host = ORIGIN,
) {
	const init: RequestInit = { method, headers: { ...headers } };
	if (body !== undefined) {
		init.body = JSON.stringify(body);
		(init.headers as Record<string, string>)["content-type"] =
			"application/json";
	}
	return createApp({ createDeps: () => deps }).request(
		`${host}/api/admin/v1${path}`,
		init,
		deps.env,
	);
}

const slug = () => `p-${crypto.randomUUID().slice(0, 8)}`;

describe("authMiddleware", () => {
	it("returns 401 with no credential", async () => {
		const { deps } = clock();
		const res = await request(deps, "GET", "/me");
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "unauthorized" });
	});

	it("ignores a non-Bearer Authorization header and returns 401", async () => {
		const { deps } = clock();
		const res = await request(deps, "GET", "/me", {
			authorization: "Basic dXNlcjpwYXNz",
		});
		expect(res.status).toBe(401);
	});

	it("returns 401 for an unknown cookie", async () => {
		const { deps } = clock();
		const res = await request(deps, "GET", "/me", {
			cookie: `${SESSION_COOKIE}=not-a-real-token`,
		});
		expect(res.status).toBe(401);
	});

	it("returns 401 for an empty cookie value", async () => {
		const { deps } = clock();
		const res = await request(deps, "GET", "/me", {
			cookie: `${SESSION_COOKIE}=`,
		});
		expect(res.status).toBe(401);
	});

	it("returns 401 once the session is idle-expired", async () => {
		const { deps, set } = clock();
		// last-seen is within SESSION_TOUCH_MS of the deadline, so the 200
		// request below does not touch (and thus does not extend) the session.
		const { token } = await cookieSession(deps, {
			createdAt: T0,
			lastSeenAt: T0 + SESSION_IDLE_MS - SESSION_TOUCH_MS,
			expiresAt: T0 + SESSION_IDLE_MS,
		});
		set(T0 + SESSION_IDLE_MS - 1);
		expect(
			(
				await request(deps, "GET", "/me", {
					cookie: `${SESSION_COOKIE}=${token}`,
				})
			).status,
		).toBe(200);
		set(T0 + SESSION_IDLE_MS);
		const res = await request(deps, "GET", "/me", {
			cookie: `${SESSION_COOKIE}=${token}`,
		});
		expect(res.status).toBe(401);
	});

	it("returns 401 once the session is absolute-expired", async () => {
		const { deps, set } = clock();
		// Plenty of idle time left, but the 7-day cap has passed.
		const { token } = await cookieSession(deps, {
			createdAt: T0,
			lastSeenAt: T0 + SESSION_ABSOLUTE_MS - 60_000,
			expiresAt: T0 + SESSION_ABSOLUTE_MS,
		});
		set(T0 + SESSION_ABSOLUTE_MS);
		const res = await request(deps, "GET", "/me", {
			cookie: `${SESSION_COOKIE}=${token}`,
		});
		expect(res.status).toBe(401);
	});

	it("rejects a disabled user's session on the very next request", async () => {
		const { deps } = clock();
		const { username, token } = await cookieSession(deps);
		const headers = { cookie: `${SESSION_COOKIE}=${token}` };
		expect((await request(deps, "GET", "/me", headers)).status).toBe(200);
		await deps.db
			.update(users)
			.set({ disabledAt: deps.now() })
			.where(eq(users.username, username));
		expect((await request(deps, "GET", "/me", headers)).status).toBe(401);
	});

	it("rejects a disabled user's token on the very next request", async () => {
		const { deps } = clock();
		const { username, token } = await bearerToken(deps);
		const headers = { authorization: `Bearer ${token}` };
		expect((await request(deps, "GET", "/me", headers)).status).toBe(200);
		await deps.db
			.update(users)
			.set({ disabledAt: deps.now() })
			.where(eq(users.username, username));
		expect((await request(deps, "GET", "/me", headers)).status).toBe(401);
	});

	it("rejects a password-less user's session", async () => {
		const { deps } = clock();
		const { token } = await cookieSession(deps);
		await deps.db.update(users).set({ passwordHash: null });
		const res = await request(deps, "GET", "/me", {
			cookie: `${SESSION_COOKIE}=${token}`,
		});
		expect(res.status).toBe(401);
	});

	it("applies a demotion on the next request (403 on POST /projects)", async () => {
		const { deps } = clock();
		const { username, token } = await cookieSession(deps, { role: "admin" });
		const headers = { cookie: `${SESSION_COOKIE}=${token}`, origin: ORIGIN };
		const created = await request(deps, "POST", "/projects", headers, {
			name: "Demote",
			slug: slug(),
		});
		expect(created.status).toBeLessThan(300);
		await deps.db
			.update(users)
			.set({ role: "viewer" })
			.where(eq(users.username, username));
		const res = await request(deps, "POST", "/projects", headers, {
			name: "Demoted",
			slug: slug(),
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: "forbidden" });
	});

	it.each([
		["no Origin", {}],
		["Origin: null", { origin: "null" }],
		["a cross-origin Origin", { origin: "https://evil.example" }],
	])(
		"returns 403 bad_origin for a cookie POST with %s",
		async (_label, extra) => {
			const { deps } = clock();
			const { token } = await cookieSession(deps);
			const res = await request(
				deps,
				"POST",
				"/projects",
				{
					cookie: `${SESSION_COOKIE}=${token}`,
					...extra,
				},
				{ name: "Nope", slug: slug() },
			);
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: "bad_origin" });
		},
	);

	it("allows a cookie GET without an Origin", async () => {
		const { deps } = clock();
		const { token } = await cookieSession(deps);
		const res = await request(deps, "GET", "/me", {
			cookie: `${SESSION_COOKIE}=${token}`,
		});
		expect(res.status).toBe(200);
	});

	it("accepts the same cookie against another host with a matching Origin", async () => {
		const { deps } = clock();
		const { token } = await cookieSession(deps, { role: "admin" });
		const other = "https://other-host.example";
		const res = await request(
			deps,
			"POST",
			"/projects",
			{ cookie: `${SESSION_COOKIE}=${token}`, origin: other },
			{ name: "Other host", slug: slug() },
			other,
		);
		expect(res.status).toBeLessThan(300);
	});

	it("lets a Bearer request through with no Origin", async () => {
		const { deps } = clock();
		const { token } = await bearerToken(deps, { role: "admin" });
		const res = await request(
			deps,
			"POST",
			"/projects",
			{ authorization: `Bearer ${token}` },
			{ name: "Bearer", slug: slug() },
		);
		expect(res.status).toBeLessThan(300);
	});

	it("rejects a Bearer value without the hf_ prefix", async () => {
		const { deps } = clock();
		const res = await request(deps, "GET", "/me", {
			authorization: "Bearer not-a-hookflare-token",
		});
		expect(res.status).toBe(401);
	});

	it("returns 400 ambiguous_credentials for a cookie plus a Bearer", async () => {
		const { deps } = clock();
		const { token: cookie } = await cookieSession(deps);
		const { token: bearer } = await bearerToken(deps);
		const res = await request(deps, "GET", "/me", {
			cookie: `${SESSION_COOKIE}=${cookie}`,
			authorization: `Bearer ${bearer}`,
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "ambiguous_credentials" });
	});

	it("returns 401 for a revoked token", async () => {
		const { deps } = clock();
		const { token } = await bearerToken(deps, { revokedAt: T0 - 1 });
		const res = await request(deps, "GET", "/me", {
			authorization: `Bearer ${token}`,
		});
		expect(res.status).toBe(401);
	});

	it("returns 401 for an expired token", async () => {
		const { deps, set } = clock();
		const { token } = await bearerToken(deps, { expiresAt: T0 + 1_000 });
		set(T0 + 1_000);
		const res = await request(deps, "GET", "/me", {
			authorization: `Bearer ${token}`,
		});
		expect(res.status).toBe(401);
	});

	it("returns 401 for an unknown token", async () => {
		const { deps } = clock();
		const res = await request(deps, "GET", "/me", {
			authorization: `Bearer hf_${randomToken()}`,
		});
		expect(res.status).toBe(401);
	});

	it("reports a viewer's username and role from a Bearer token", async () => {
		const { deps } = clock();
		const { username, token } = await bearerToken(deps, { role: "viewer" });
		const res = await request(deps, "GET", "/me", {
			authorization: `Bearer ${token}`,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ username, role: "viewer" });
	});

	it("touches last_seen_at only after SESSION_TOUCH_MS", async () => {
		const { deps, set } = clock();
		const { token, idHash } = await cookieSession(deps, {
			createdAt: T0,
			lastSeenAt: T0,
		});
		const header = { cookie: `${SESSION_COOKIE}=${token}` };
		const read = async () =>
			(
				await deps.db.select().from(sessions).where(eq(sessions.idHash, idHash))
			)[0];
		set(T0 + SESSION_TOUCH_MS - 1);
		expect((await request(deps, "GET", "/me", header)).status).toBe(200);
		expect((await read())?.lastSeenAt).toBe(T0);
		set(T0 + SESSION_TOUCH_MS);
		expect((await request(deps, "GET", "/me", header)).status).toBe(200);
		expect((await read())?.lastSeenAt).toBe(T0 + SESSION_TOUCH_MS);
	});

	it("touches a never-used token's last_used_at", async () => {
		const { deps } = clock();
		const { token } = await bearerToken(deps, { lastUsedAt: null });
		expect(
			(
				await request(deps, "GET", "/me", {
					authorization: `Bearer ${token}`,
				})
			).status,
		).toBe(200);
		const [row] = await deps.db
			.select()
			.from(apiTokens)
			.where(eq(apiTokens.tokenHash, await sha256Hex(token)));
		expect(row?.lastUsedAt).toBe(T0);
	});
});

describe("setSessionCookie", () => {
	function cookieApp() {
		const app = new Hono<AppBindings>();
		app.get("/set", (c) => {
			setSessionCookie(c, "the-token");
			return c.body(null);
		});
		app.get("/clear", (c) => {
			clearSessionCookie(c);
			return c.body(null);
		});
		return app;
	}

	it("sets the HttpOnly, Strict, admin-path cookie with the absolute Max-Age", async () => {
		const res = await cookieApp().request("https://hookflare.example.com/set");
		const cookie = res.headers.get("set-cookie") ?? "";
		expect(cookie).toContain(`${SESSION_COOKIE}=the-token`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).toContain("Path=/api/admin");
		expect(cookie).toContain(`Max-Age=${SESSION_ABSOLUTE_MS / 1000}`);
		expect(cookie).toContain("Secure");
	});

	it("omits Secure only for localhost/127.0.0.1", async () => {
		const localhost = await cookieApp().request("http://localhost:8787/set");
		expect(localhost.headers.get("set-cookie")).not.toContain("Secure");
		const loopback = await cookieApp().request("http://127.0.0.1:8787/set");
		expect(loopback.headers.get("set-cookie")).not.toContain("Secure");
	});

	it("clears the cookie on the same path with matching Secure/SameSite", async () => {
		const res = await cookieApp().request(
			"https://hookflare.example.com/clear",
		);
		const cookie = res.headers.get("set-cookie") ?? "";
		expect(cookie).toContain(`${SESSION_COOKIE}=`);
		expect(cookie).toContain("Path=/api/admin");
		expect(cookie).toContain("Max-Age=0");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).toContain("Secure");
	});

	it("omits Secure when clearing on localhost, like the set path", async () => {
		const localhost = await cookieApp().request("http://localhost:8787/clear");
		const cookie = localhost.headers.get("set-cookie") ?? "";
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).not.toContain("Secure");
		const loopback = await cookieApp().request("http://127.0.0.1:8787/clear");
		expect(loopback.headers.get("set-cookie")).not.toContain("Secure");
	});
});

describe("isSameOrigin", () => {
	function originApp() {
		const app = new Hono<AppBindings>();
		app.get("/", (c) => c.json({ same: isSameOrigin(c) }));
		return app;
	}

	it.each([
		["a missing Origin", undefined, false],
		["Origin: null", "null", false],
		["a different origin", "https://evil.example", false],
		["the request origin", ORIGIN, true],
	] as const)("returns %s → %s", async (_label, origin, expected) => {
		const headers: Record<string, string> =
			origin === undefined ? {} : { origin };
		const res = await originApp().request(`${ORIGIN}/`, { headers });
		expect(await res.json()).toEqual({ same: expected });
	});
});
