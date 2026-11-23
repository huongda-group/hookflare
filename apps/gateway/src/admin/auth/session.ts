import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppBindings } from "../../app";
import { findTokenActor, touchApiTokenStmt } from "../../core/db/api-tokens";
import {
	findSessionActor,
	SESSION_ABSOLUTE_MS,
	SESSION_TOUCH_MS,
	touchSessionStmt,
} from "../../core/db/sessions";
import { sha256Hex } from "./secrets";

export const SESSION_COOKIE = "hookflare_session";

const COOKIE_PATH = "/api/admin";
const TOKEN_PREFIX = "hf_";
const BEARER = /^Bearer[ ]+(.*)$/i;

function isLocalhost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1";
}

export function setSessionCookie(c: Context<AppBindings>, token: string): void {
	const { hostname } = new URL(c.req.url);
	setCookie(c, SESSION_COOKIE, token, {
		httpOnly: true,
		sameSite: "Strict",
		path: COOKIE_PATH,
		maxAge: SESSION_ABSOLUTE_MS / 1000,
		secure: !isLocalhost(hostname),
	});
}

export function clearSessionCookie(c: Context<AppBindings>): void {
	const { hostname } = new URL(c.req.url);
	deleteCookie(c, SESSION_COOKIE, {
		path: COOKIE_PATH,
		secure: !isLocalhost(hostname),
		sameSite: "Strict",
	});
}

export function isSameOrigin(c: Context<AppBindings>): boolean {
	const origin = c.req.header("origin");
	return origin !== undefined && origin === new URL(c.req.url).origin;
}

function bearerToken(header: string | undefined): string | undefined {
	if (!header) return undefined;
	const match = BEARER.exec(header.trim());
	return match?.[1];
}

export function authMiddleware(): MiddlewareHandler<AppBindings> {
	return async (c, next) => {
		const cookie = getCookie(c, SESSION_COOKIE);
		const bearer = bearerToken(c.req.header("authorization"));
		if (cookie && bearer !== undefined) {
			return c.json({ error: "ambiguous_credentials" }, 400);
		}
		if (bearer !== undefined) {
			return authenticateToken(c, next, bearer);
		}
		if (cookie) {
			return authenticateSession(c, next, cookie);
		}
		return c.json({ error: "unauthorized" }, 401);
	};
}

async function authenticateToken(
	c: Context<AppBindings>,
	next: () => Promise<void>,
	token: string,
): Promise<Response | undefined> {
	if (!token.startsWith(TOKEN_PREFIX)) {
		return c.json({ error: "unauthorized" }, 401);
	}
	const { db, now } = c.var.deps;
	const at = now();
	const actor = await findTokenActor(db, await sha256Hex(token), at);
	if (!actor) return c.json({ error: "unauthorized" }, 401);
	if (actor.lastUsedAt === null || at - actor.lastUsedAt >= SESSION_TOUCH_MS) {
		await touchApiTokenStmt(db, actor.tokenId, at);
	}
	c.set("actor", { username: actor.username, role: actor.role });
	await next();
}

async function authenticateSession(
	c: Context<AppBindings>,
	next: () => Promise<void>,
	token: string,
): Promise<Response | undefined> {
	const { db, now } = c.var.deps;
	const at = now();
	const idHash = await sha256Hex(token);
	const session = await findSessionActor(db, idHash, at);
	if (!session) return c.json({ error: "unauthorized" }, 401);
	const method = c.req.method;
	if (method !== "GET" && method !== "HEAD" && !isSameOrigin(c)) {
		return c.json({ error: "bad_origin" }, 403);
	}
	if (at - session.lastSeenAt >= SESSION_TOUCH_MS) {
		await touchSessionStmt(db, idHash, session.createdAt, at);
	}
	c.set("actor", {
		username: session.username,
		role: session.role,
		sessionIdHash: idHash,
	});
	await next();
}
