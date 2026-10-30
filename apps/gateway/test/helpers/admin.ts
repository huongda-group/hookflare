import { asc, eq } from "drizzle-orm";
import { randomToken, sha256Hex } from "../../src/admin/auth/secrets";
import { SESSION_COOKIE } from "../../src/admin/auth/session";
import { createApp } from "../../src/app";
import {
	apiTokens,
	auditLogs,
	type Role,
	users,
} from "../../src/core/db/schema";
import { insertSessionStmt } from "../../src/core/db/sessions";
import { newId } from "../../src/core/ids";
import type { Deps } from "../../src/deps";

/**
 * Only "IS NOT NULL" matters to the auth queries; the value is never parsed
 * by the middleware (same convention as the sessions/api-tokens unit tests).
 */
const PASSWORD_HASH = "pbkdf2-sha256$100000$c2FsdA==$aGFzaA==";

const ORIGIN = "https://hookflare.example.com";
const ADMIN_API = `${ORIGIN}/api/admin/v1`;

/** The default identity used when `adminApp` is called with no role. */
export const DEFAULT_ADMIN = "admin@example.com";

export function uniqueUsername(prefix = "user"): string {
	return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Audit rows for one resource, oldest first. */
/** Runs `before` right ahead of the next db.batch, i.e. after the handler's read. */
export function beforeNextBatch(deps: Deps, before: () => Promise<unknown>) {
	const batch = deps.db.batch.bind(deps.db);
	deps.db.batch = (async (queries: Parameters<typeof batch>[0]) => {
		deps.db.batch = batch;
		await before();
		return batch(queries);
	}) as unknown as typeof batch;
}

export async function auditRows(deps: Deps, resourceId: string) {
	return deps.db
		.select()
		.from(auditLogs)
		.where(eq(auditLogs.resourceId, resourceId))
		.orderBy(asc(auditLogs.id));
}

/**
 * Admin API client (M7). Upserts an enabled user that has a password, then
 * inserts a session (or an API token) directly and sends the matching
 * credential. With no options it authenticates as the default admin; with a
 * role it creates a fresh user under that role.
 */
export async function adminApp(
	deps: Deps,
	opts: { role?: Role; username?: string; via?: "cookie" | "token" } = {},
) {
	const username =
		opts.username ?? (opts.role ? uniqueUsername(opts.role) : DEFAULT_ADMIN);
	const now = deps.now();
	await deps.db
		.insert(users)
		.values({
			username,
			role: opts.role ?? "admin",
			passwordHash: PASSWORD_HASH,
			passwordChangedAt: null,
			createdAt: now,
			updatedAt: now,
			disabledAt: null,
		})
		.onConflictDoUpdate({
			target: users.username,
			// An existing user keeps its role (the caller passed no role to change
			// it); the row must stay enabled and password-bearing to authenticate.
			set: {
				...(opts.role ? { role: opts.role } : {}),
				passwordHash: PASSWORD_HASH,
				disabledAt: null,
				updatedAt: now,
			},
		});

	const app = createApp({ createDeps: () => deps });
	const via = opts.via ?? "cookie";
	let credential: string;
	if (via === "cookie") {
		credential = randomToken();
		await insertSessionStmt(deps.db, {
			idHash: await sha256Hex(credential),
			username,
			now,
		});
	} else {
		credential = randomToken("hf_");
		await deps.db.insert(apiTokens).values({
			id: newId("tok", now),
			tokenHash: await sha256Hex(credential),
			username,
			name: "test",
			createdAt: now,
			expiresAt: null,
			lastUsedAt: null,
			revokedAt: null,
		});
	}

	return {
		username,
		request(
			method: string,
			path: string,
			body?: unknown,
			headers: Record<string, string> = {},
		) {
			const init: RequestInit = { method, headers: { ...headers } };
			const sent = init.headers as Record<string, string>;
			if (via === "cookie") {
				sent.cookie = `${SESSION_COOKIE}=${credential}`;
				sent.origin = ORIGIN;
			} else {
				sent.authorization = `Bearer ${credential}`;
			}
			if (body !== undefined) {
				init.body = typeof body === "string" ? body : JSON.stringify(body);
				sent["content-type"] = "application/json";
			}
			return app.request(`${ADMIN_API}${path}`, init, deps.env);
		},
	};
}
