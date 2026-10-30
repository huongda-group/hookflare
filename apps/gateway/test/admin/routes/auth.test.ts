import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "../../../src/admin/auth/password";
import { TURNSTILE_TEST_SECRET } from "../../../src/admin/auth/turnstile";
import { createApp } from "../../../src/app";
import {
	apiTokens,
	auditLogs,
	sessions,
	users,
} from "../../../src/core/db/schema";
import { getUser } from "../../../src/core/db/users";
import type { Deps } from "../../../src/deps";
import { testDeps } from "../../helpers/deps";
import { denyAllLimiter, testEnv } from "../../helpers/env";

/**
 * The route imports `verifyPassword` directly, and `vi.mock` does not intercept
 * that import under the Cloudflare pool, so count PBKDF2 passes at the global
 * `crypto.subtle` seam instead: every `hashPassword`/`verifyPassword` call runs
 * exactly one `deriveBits`. This is what keeps the "one PBKDF2 pass per login
 * attempt" guarantee honest.
 */
const deriveSpy = vi.spyOn(crypto.subtle, "deriveBits");

const ORIGIN = "https://hookflare.example.com";
const LOCALHOST = "http://localhost:8787";
const ADMIN_API = (host: string) => `${host}/api/admin/v1`;
const PASSWORD = "correct-horse-battery";

/** Shared storage across the file, so each test starts from an empty DB. */
const shared = testDeps();
beforeEach(async () => {
	deriveSpy.mockClear();
	await shared.db.delete(auditLogs);
	await shared.db.delete(sessions);
	await shared.db.delete(apiTokens);
	await shared.db.delete(users);
});

type RequestOpts = {
	body?: unknown;
	rawBody?: string;
	headers?: Record<string, string>;
	/** `null` omits the Origin header; undefined defaults to the host origin. */
	origin?: string | null;
	host?: string;
};

function request(
	deps: Deps,
	method: string,
	path: string,
	opts: RequestOpts = {},
) {
	const host = opts.host ?? ORIGIN;
	const headers: Record<string, string> = { ...opts.headers };
	const origin = opts.origin === undefined ? new URL(host).origin : opts.origin;
	if (origin !== null) headers.origin = origin;
	const init: RequestInit = { method, headers };
	if (opts.rawBody !== undefined) {
		init.body = opts.rawBody;
		headers["content-type"] ??= "application/json";
	} else if (opts.body !== undefined) {
		init.body = JSON.stringify(opts.body);
		headers["content-type"] = "application/json";
	}
	return createApp({ createDeps: () => deps }).request(
		`${ADMIN_API(host)}${path}`,
		init,
		deps.env,
	);
}

async function seedUser(
	deps: Deps,
	row: Partial<typeof users.$inferInsert> & { username: string },
) {
	const now = deps.now();
	await deps.db.insert(users).values({
		role: "admin",
		passwordHash: null,
		passwordChangedAt: null,
		createdAt: now,
		updatedAt: now,
		disabledAt: null,
		...row,
	});
}

async function seedAdmin(deps: Deps, password = PASSWORD, username = "admin") {
	await seedUser(deps, {
		username,
		role: "admin",
		passwordHash: await hashPassword(password),
	});
}

function cookieOf(res: Response): string {
	return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

function recordingLimiter() {
	const keys: string[] = [];
	const limit = vi.fn(async ({ key }: { key: string }) => {
		keys.push(key);
		return { success: true };
	});
	return { keys, limit, limiter: { limit } as unknown as RateLimit };
}

describe("GET /auth/state", () => {
	it("reports setup required on an empty DB", async () => {
		const deps = testDeps();
		const res = await request(deps, "GET", "/auth/state");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			setup_required: true,
			turnstile_site_key: null,
		});
	});

	it("reports setup required when only password-less rows exist", async () => {
		const deps = testDeps();
		await seedUser(deps, { username: "legacy", role: "operator" });
		const res = await request(deps, "GET", "/auth/state");
		expect(await res.json()).toEqual({
			setup_required: true,
			turnstile_site_key: null,
		});
	});

	it("reports setup closed and exposes the site key once a password exists", async () => {
		const deps = testDeps({
			env: testEnv({
				TURNSTILE_SITE_KEY: "site-key",
				TURNSTILE_SECRET_KEY: "secret",
			}),
		});
		await seedAdmin(deps);
		const res = await request(deps, "GET", "/auth/state");
		expect(await res.json()).toEqual({
			setup_required: false,
			turnstile_site_key: "site-key",
		});
	});
});

describe("POST /auth/setup", () => {
	it("rejects a stale setup_token with 400", async () => {
		const deps = testDeps();
		const res = await request(deps, "POST", "/auth/setup", {
			body: { username: "admin", password: PASSWORD, setup_token: "stale" },
		});
		expect(res.status).toBe(400);
	});

	it("rejects a password equal to the username", async () => {
		const deps = testDeps();
		const res = await request(deps, "POST", "/auth/setup", {
			body: {
				username: "admintwelve1",
				password: "admintwelve1",
			},
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "password_equals_username" });
	});

	it("onboards a migrated password-less row of the same username", async () => {
		const deps = testDeps();
		await seedUser(deps, { username: "admin", role: "operator" });
		const res = await request(deps, "POST", "/auth/setup", {
			body: {
				username: "admin",
				password: PASSWORD,
			},
		});
		expect(res.status).toBe(201);
		const row = await getUser(deps.db, "admin");
		expect(row).toMatchObject({
			username: "admin",
			role: "admin",
			disabledAt: null,
		});
		expect(row?.passwordHash).not.toBeNull();
		expect(await verifyPassword(PASSWORD, row?.passwordHash ?? null)).toBe(
			true,
		);
	});

	it("lets exactly one of two concurrent setups win", async () => {
		const deps = testDeps();
		const body = {
			username: "admin",
			password: PASSWORD,
		};
		const [a, b] = await Promise.all([
			request(deps, "POST", "/auth/setup", { body }),
			request(deps, "POST", "/auth/setup", { body }),
		]);
		const statuses = [a.status, b.status].sort((x, y) => x - y);
		expect(statuses).toEqual([201, 409]);
		const loser = [a, b].find((r) => r.status === 409) as Response;
		expect(await loser.json()).toEqual({ error: "setup_closed" });
		const onboarded = await deps.db
			.select()
			.from(auditLogs)
			.where(eq(auditLogs.action, "user.onboarded"));
		expect(onboarded).toHaveLength(1);
	});

	it("also reads the body after the limiter for malformed input", async () => {
		const { limit, limiter } = recordingLimiter();
		const deps = testDeps({ env: testEnv({ LOGIN_LIMITER: limiter }) });
		const res = await request(deps, "POST", "/auth/setup", { rawBody: "{" });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "invalid_request" });
		expect(limit).toHaveBeenCalledTimes(1);
	});

	it("returns 500 when Turnstile is misconfigured", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const deps = testDeps({ env: testEnv({ TURNSTILE_SITE_KEY: "site" }) });
		const res = await request(deps, "POST", "/auth/setup", {
			body: {
				username: "admin",
				password: PASSWORD,
			},
		});
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "internal_error" });
		errorSpy.mockRestore();
	});
});

describe("POST /auth/login", () => {
	it("sets a Secure, HttpOnly, SameSite=Strict session cookie", async () => {
		const deps = testDeps();
		await seedAdmin(deps);
		const res = await request(deps, "POST", "/auth/login", {
			body: { username: "admin", password: PASSWORD },
		});
		expect(res.status).toBe(204);
		const cookie = res.headers.get("set-cookie") ?? "";
		expect(cookie).toContain("hookflare_session=");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).toContain("Path=/api/admin");
		expect(cookie).toContain("Secure");
	});

	it("omits Secure on http://localhost", async () => {
		const deps = testDeps();
		await seedAdmin(deps);
		const res = await request(deps, "POST", "/auth/login", {
			body: { username: "admin", password: PASSWORD },
			host: LOCALHOST,
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("set-cookie") ?? "").not.toContain("Secure");
	});

	it("returns a byte-identical 401 for every failure kind, hashing once", async () => {
		const deps = testDeps();
		await seedAdmin(deps);
		await seedUser(deps, {
			username: "disabled",
			role: "operator",
			passwordHash: await hashPassword(PASSWORD),
			disabledAt: deps.now(),
		});
		await seedUser(deps, { username: "nopass", role: "operator" });
		const cases = [
			{ username: "missing", password: PASSWORD, why: "unknown user" },
			{
				username: "admin",
				password: "wrong-password-xx",
				why: "wrong password",
			},
			{ username: "disabled", password: PASSWORD, why: "disabled user" },
			{ username: "nopass", password: PASSWORD, why: "password-less user" },
		];
		const bodies: string[] = [];
		for (const c of cases) {
			deriveSpy.mockClear();
			const res = await request(deps, "POST", "/auth/login", {
				body: { username: c.username, password: c.password },
			});
			expect(res.status, c.why).toBe(401);
			bodies.push(await res.text());
			expect(deriveSpy, c.why).toHaveBeenCalledTimes(1);
		}
		expect(new Set(bodies).size).toBe(1);
	});

	it("lowercases and trims the username", async () => {
		const deps = testDeps();
		await seedAdmin(deps);
		const res = await request(deps, "POST", "/auth/login", {
			body: { username: "  Admin ", password: PASSWORD },
		});
		expect(res.status).toBe(204);
	});

	it("never trims the password", async () => {
		const deps = testDeps();
		const exact = "  pässwörd 12345 ";
		await seedAdmin(deps, exact);
		const ok = await request(deps, "POST", "/auth/login", {
			body: { username: "admin", password: exact },
		});
		expect(ok.status).toBe(204);
		const trimmed = await request(deps, "POST", "/auth/login", {
			body: { username: "admin", password: exact.trim() },
		});
		expect(trimmed.status).toBe(401);
	});

	it("maps malformed and oversized bodies to 400 and still counts the limiter", async () => {
		const { limit, limiter } = recordingLimiter();
		const deps = testDeps({ env: testEnv({ LOGIN_LIMITER: limiter }) });
		const malformed = await request(deps, "POST", "/auth/login", {
			rawBody: "{",
		});
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ error: "invalid_request" });
		const oversized = await request(deps, "POST", "/auth/login", {
			rawBody: JSON.stringify({
				username: "admin",
				password: "x".repeat(300 * 1024),
			}),
		});
		expect(oversized.status).toBe(400);
		expect(await oversized.json()).toMatchObject({ error: "invalid_request" });
		expect(limit).toHaveBeenCalledTimes(2);
	});

	it("rejects a non-same-origin request with 403", async () => {
		const deps = testDeps();
		const res = await request(deps, "POST", "/auth/login", {
			body: { username: "admin", password: PASSWORD },
			origin: "https://evil.example",
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "bad_origin" });
	});

	it("denies before Turnstile and the password hash", async () => {
		const deps = testDeps({
			env: testEnv({
				LOGIN_LIMITER: denyAllLimiter,
				TURNSTILE_SITE_KEY: "site",
				TURNSTILE_SECRET_KEY: "secret",
			}),
		});
		await seedAdmin(deps);
		deriveSpy.mockClear();
		const res = await request(deps, "POST", "/auth/login", {
			body: { username: "admin", password: PASSWORD, turnstile_token: "tok" },
		});
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: "too_many_attempts" });
		expect(deriveSpy).not.toHaveBeenCalled();
		expect(deps.fetch).not.toHaveBeenCalled();
	});

	it("returns 403 before hashing when Turnstile rejects the token", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ success: false }), { status: 200 }),
		);
		const deps = testDeps({
			env: testEnv({
				TURNSTILE_SITE_KEY: "site",
				TURNSTILE_SECRET_KEY: "secret",
			}),
			fetch: fetchMock as unknown as typeof fetch,
		});
		await seedAdmin(deps);
		deriveSpy.mockClear();
		const res = await request(deps, "POST", "/auth/login", {
			body: { username: "admin", password: PASSWORD, turnstile_token: "tok" },
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "turnstile_failed" });
		expect(deriveSpy).not.toHaveBeenCalled();
	});

	it("returns 503 when siteverify is unavailable", async () => {
		const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
		const deps = testDeps({
			env: testEnv({
				TURNSTILE_SITE_KEY: "site",
				TURNSTILE_SECRET_KEY: "secret",
			}),
			fetch: fetchMock as unknown as typeof fetch,
		});
		await seedAdmin(deps);
		const res = await request(deps, "POST", "/auth/login", {
			body: { username: "admin", password: PASSWORD, turnstile_token: "tok" },
		});
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "turnstile_unavailable" });
	});

	it("skips the action and hostname checks for the Turnstile test secret", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ success: true }), { status: 200 }),
		);
		const deps = testDeps({
			env: testEnv({
				TURNSTILE_SITE_KEY: "site",
				TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET,
			}),
			fetch: fetchMock as unknown as typeof fetch,
		});
		await seedAdmin(deps);
		const res = await request(deps, "POST", "/auth/login", {
			body: { username: "admin", password: PASSWORD, turnstile_token: "tok" },
		});
		expect(res.status).toBe(204);
		expect(fetchMock).toHaveBeenCalled();
	});

	it("returns 500 and logs when only one Turnstile key is set", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const deps = testDeps({ env: testEnv({ TURNSTILE_SITE_KEY: "site" }) });
		const res = await request(deps, "POST", "/auth/login", {
			body: { username: "admin", password: PASSWORD, turnstile_token: "tok" },
		});
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "internal_error" });
		const lines = errorSpy.mock.calls.map((call) => String(call[0]));
		expect(lines.some((l) => l.includes("admin.turnstile_misconfigured"))).toBe(
			true,
		);
		errorSpy.mockRestore();
	});
});

describe("POST /auth/logout", () => {
	it("deletes the session and the next /me returns 401", async () => {
		const deps = testDeps();
		await seedAdmin(deps);
		const login = await request(deps, "POST", "/auth/login", {
			body: { username: "admin", password: PASSWORD },
		});
		expect(login.status).toBe(204);
		const cookie = cookieOf(login);

		const me = await request(deps, "GET", "/me", { headers: { cookie } });
		expect(me.status).toBe(200);

		const logout = await request(deps, "POST", "/auth/logout", {
			headers: { cookie },
		});
		expect(logout.status).toBe(204);

		const after = await request(deps, "GET", "/me", { headers: { cookie } });
		expect(after.status).toBe(401);
	});

	it("requires a same-origin request", async () => {
		const deps = testDeps();
		const res = await request(deps, "POST", "/auth/logout", {
			origin: "https://evil.example",
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "bad_origin" });
	});
});

describe("login rate limiting key", () => {
	it("keys by ip and never includes the username", async () => {
		const { keys, limiter } = recordingLimiter();
		const deps = testDeps({ env: testEnv({ LOGIN_LIMITER: limiter }) });
		await request(deps, "POST", "/auth/login", {
			body: { username: "top-secret-user", password: "wrong-password-xx" },
			headers: { "cf-connecting-ip": "203.0.113.7" },
		});
		expect(keys).toEqual(["ip:203.0.113.7"]);
		expect(keys.join(" ")).not.toContain("top-secret-user");
	});

	it("falls back to ip:unknown without the header", async () => {
		const { keys, limiter } = recordingLimiter();
		const deps = testDeps({ env: testEnv({ LOGIN_LIMITER: limiter }) });
		await request(deps, "POST", "/auth/login", {
			body: { username: "admin", password: "wrong-password-xx" },
		});
		expect(keys).toEqual(["ip:unknown"]);
	});
});
