import { type AuthState, loginRequest, setupRequest } from "@hookflare/shared";
import { isNotNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { ZodError } from "zod";
import type { AppBindings } from "../../app";
import { auditInsertIfChanged } from "../../core/audit";
import { readCappedBody } from "../../core/body";
import { sessions, users } from "../../core/db/schema";
import {
	deleteSessionStmt,
	insertSessionStmt,
	SESSION_ABSOLUTE_MS,
	SESSION_IDLE_MS,
} from "../../core/db/sessions";
import { getUser } from "../../core/db/users";
import type { Db } from "../../deps";
import { hashPassword, verifyPassword } from "../auth/password";
import { randomToken, sha256Hex } from "../auth/secrets";
import {
	clearSessionCookie,
	isSameOrigin,
	SESSION_COOKIE,
	setSessionCookie,
} from "../auth/session";
import {
	type TurnstileAction,
	turnstileConfig,
	verifyTurnstile,
} from "../auth/turnstile";
import { MAX_ADMIN_BODY_BYTES } from "../http";

const decoder = new TextDecoder();

function invalidRequest(c: Context<AppBindings>, issues: unknown[]): Response {
	return c.json({ error: "invalid_request", issues }, 400);
}

function issuesOf(error: ZodError) {
	return error.issues.map((i) => ({
		path: i.path.join("."),
		code: i.code,
		message: i.message,
	}));
}

type RawBody = { ok: true; raw: unknown } | { ok: false; response: Response };

/**
 * R11: the public auth endpoints return `400 invalid_request` for a malformed
 * or oversized body, unlike the shared `readJson` (413). The limiter has
 * already run by the time this is called, so a bad body still counts.
 */
async function readBody(c: Context<AppBindings>): Promise<RawBody> {
	const bytes = await readCappedBody(c.req.raw, MAX_ADMIN_BODY_BYTES);
	if (!bytes) {
		return {
			ok: false,
			response: invalidRequest(c, [
				{
					path: "",
					code: "payload_too_large",
					message: `Body is larger than ${MAX_ADMIN_BODY_BYTES} bytes`,
				},
			]),
		};
	}
	try {
		return { ok: true, raw: JSON.parse(decoder.decode(bytes)) };
	} catch {
		return {
			ok: false,
			response: invalidRequest(c, [
				{ path: "", code: "invalid_json", message: "Body is not valid JSON" },
			]),
		};
	}
}

/** A top-level string field of a parsed JSON body, or undefined. */
function stringField(raw: unknown, key: string): string | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const value = (raw as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * Per-attempt order (spec §6.5.1): the limiter and body read have already run,
 * so this is Turnstile. Turnstile never fails open: a misconfigured pair is a
 * 500, a rejected token a 403, and an unreachable siteverify a 503.
 */
async function guardTurnstile(
	c: Context<AppBindings>,
	action: TurnstileAction,
	token: string | undefined,
): Promise<Response | null> {
	const config = turnstileConfig(c.env);
	if (config.mode === "misconfigured") {
		c.var.logger.error("admin.turnstile_misconfigured", { action });
		return c.json({ error: "internal_error" }, 500);
	}
	if (config.mode === "off") return null;
	const result = await verifyTurnstile(c.var.deps.fetch, {
		secret: config.secret,
		token,
		remoteIp: c.req.header("cf-connecting-ip") ?? null,
		action,
		hostname: new URL(c.req.url).hostname,
	});
	if (result === "ok") return null;
	return result === "unavailable"
		? c.json({ error: "turnstile_unavailable" }, 503)
		: c.json({ error: "turnstile_failed" }, 403);
}

/** The rate-limit key is the IP only, never the username (spec §6.5). */
function limiterKey(c: Context<AppBindings>): string {
	return `ip:${c.req.header("cf-connecting-ip") ?? "unknown"}`;
}

async function underLimit(c: Context<AppBindings>): Promise<boolean> {
	const { success } = await c.env.LOGIN_LIMITER.limit({ key: limiterKey(c) });
	return success;
}

/**
 * Statement 1 is a conditional upsert: it inserts only while no loginable
 * account exists, and otherwise promotes a password-less row of the same
 * username. The audit row and the session insert are each guarded by
 * `changes() > 0`, which D1 evaluates against the statement just before them
 * on the batch's single connection — so a lost race (0 rows) writes neither.
 */
export function setupStatements(
	db: Db,
	a: { username: string; passwordHash: string; now: number; idHash: string },
) {
	const expiresAt = Math.min(
		a.now + SESSION_ABSOLUTE_MS,
		a.now + SESSION_IDLE_MS,
	);
	// `insert().select()` requires the selected keys to match the table's
	// columns exactly, in declaration order (drizzle 0.45).
	return [
		db
			.insert(users)
			.select(
				db
					.select({
						username: sql<string>`${a.username}`.as("username"),
						role: sql<string>`'admin'`.as("role"),
						passwordHash: sql<string>`${a.passwordHash}`.as("password_hash"),
						passwordChangedAt: sql<number>`${a.now}`.as("password_changed_at"),
						createdAt: sql<number>`${a.now}`.as("created_at"),
						updatedAt: sql<number>`${a.now}`.as("updated_at"),
						disabledAt: sql<null>`NULL`.as("disabled_at"),
					})
					.from(sql`(SELECT 1)`)
					.where(
						sql`NOT EXISTS (SELECT 1 FROM users WHERE password_hash IS NOT NULL)`,
					),
			)
			.onConflictDoUpdate({
				target: users.username,
				set: {
					role: sql`'admin'`,
					passwordHash: sql`excluded.password_hash`,
					passwordChangedAt: sql`excluded.password_changed_at`,
					disabledAt: sql`NULL`,
					updatedAt: sql`excluded.updated_at`,
				},
				setWhere: sql`NOT EXISTS (SELECT 1 FROM users WHERE password_hash IS NOT NULL)`,
			}),
		auditInsertIfChanged(db, {
			actor: a.username,
			action: "user.onboarded",
			resourceType: "user",
			resourceId: a.username,
			diff: { role: "admin" },
			at: a.now,
		}),
		db.insert(sessions).select(
			db
				.select({
					idHash: sql<string>`${a.idHash}`.as("id_hash"),
					username: sql<string>`${a.username}`.as("username"),
					createdAt: sql<number>`${a.now}`.as("created_at"),
					lastSeenAt: sql<number>`${a.now}`.as("last_seen_at"),
					expiresAt: sql<number>`${expiresAt}`.as("expires_at"),
				})
				.from(sql`(SELECT 1)`)
				.where(sql`changes() > 0`),
		),
	] as const;
}

/** The public onboarding, login, and logout routes (spec §6.3–§6.5). */
export function authRoutes() {
	const routes = new Hono<AppBindings>();

	routes.get("/state", async (c) => {
		const existing = await c.var.deps.db
			.select({ username: users.username })
			.from(users)
			.where(isNotNull(users.passwordHash))
			.limit(1)
			.get();
		const config = turnstileConfig(c.env);
		return c.json({
			setup_required: existing === undefined,
			turnstile_site_key: config.mode === "on" ? config.siteKey : null,
		} satisfies AuthState);
	});

	routes.post("/setup", async (c) => {
		if (!isSameOrigin(c)) return c.json({ error: "bad_origin" }, 403);
		if (!(await underLimit(c))) {
			return c.json({ error: "too_many_attempts" }, 429);
		}
		const parsed = await readBody(c);
		if (!parsed.ok) return parsed.response;
		const turnstile = await guardTurnstile(
			c,
			"setup",
			stringField(parsed.raw, "turnstile_token"),
		);
		if (turnstile) return turnstile;

		const body = setupRequest.safeParse(parsed.raw);
		if (!body.success) return invalidRequest(c, issuesOf(body.error));
		const { username, password } = body.data;
		if (password === username) {
			return c.json({ error: "password_equals_username" }, 400);
		}

		const { db, now } = c.var.deps;
		const at = now();
		const passwordHash = await hashPassword(password);
		const token = randomToken();
		const idHash = await sha256Hex(token);
		const results = await db.batch(
			setupStatements(db, { username, passwordHash, now: at, idHash }),
		);
		// Statement 1 changed no rows: onboarding is already closed (spec §6.3).
		const changes =
			(results[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0;
		if (changes === 0) return c.json({ error: "setup_closed" }, 409);
		setSessionCookie(c, token);
		return c.json({ username, role: "admin" }, 201);
	});

	routes.post("/login", async (c) => {
		if (!isSameOrigin(c)) return c.json({ error: "bad_origin" }, 403);
		if (!(await underLimit(c))) {
			return c.json({ error: "too_many_attempts" }, 429);
		}
		const parsed = await readBody(c);
		if (!parsed.ok) return parsed.response;
		const body = loginRequest.safeParse(parsed.raw);
		if (!body.success) return invalidRequest(c, issuesOf(body.error));
		const turnstile = await guardTurnstile(
			c,
			"login",
			body.data.turnstile_token,
		);
		if (turnstile) return turnstile;

		const { username, password } = body.data;
		const { db, now } = c.var.deps;
		const user = await getUser(db, username);
		// Exactly one PBKDF2 pass per attempt, including an unknown username
		// (the dummy-hash path), so timing cannot reveal which users exist.
		const ok = await verifyPassword(password, user?.passwordHash ?? null);
		if (
			!user ||
			user.disabledAt !== null ||
			user.passwordHash === null ||
			!ok
		) {
			c.var.logger.warn("admin.login_failed", {
				username,
				reason: !user
					? "unknown_user"
					: user.disabledAt !== null
						? "disabled"
						: user.passwordHash === null
							? "no_password"
							: "wrong_password",
			});
			return c.json({ error: "invalid_credentials" }, 401);
		}

		const token = randomToken();
		await insertSessionStmt(db, {
			idHash: await sha256Hex(token),
			username,
			now: now(),
		});
		setSessionCookie(c, token);
		c.var.logger.info("admin.login_ok", { username });
		return c.body(null, 204);
	});

	routes.post("/logout", async (c) => {
		// Logout is a public auth endpoint, so it enforces the same origin
		// before touching the session (spec §6.5, ruling R12).
		if (!isSameOrigin(c)) return c.json({ error: "bad_origin" }, 403);
		const token = getCookie(c, SESSION_COOKIE);
		if (token) {
			await deleteSessionStmt(c.var.deps.db, await sha256Hex(token));
		}
		clearSessionCookie(c);
		return c.body(null, 204);
	});

	return routes;
}
