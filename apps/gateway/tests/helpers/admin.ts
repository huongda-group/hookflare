import { asc, eq } from "drizzle-orm";
import { randomToken, sha256Hex } from "../../src/admin/auth/secrets";
import { SESSION_COOKIE } from "../../src/admin/auth/session";
import { createApp } from "../../src/app";
import {
	apiTokens,
	auditLogs,
	projects,
	type Role,
	users,
} from "../../src/core/db/schema";
import { insertSessionStmt } from "../../src/core/db/sessions";
import { newId } from "../../src/core/ids";
import type { Deps } from "../../src/deps";
import { testDeps } from "./deps";

const PASSWORD_HASH = "pbkdf2-sha256$100000$c2FsdA==$aGFzaA==";

const ORIGIN = "https://hookflare.example.com";
const ADMIN_API = `${ORIGIN}/api/admin/v1`;

export const DEFAULT_ADMIN = "admin@example.com";

export async function seedAdminProject() {
	const { db, now } = testDeps();
	const at = now();
	await db
		.insert(projects)
		.values({
			id: "prj_admin_test_project",
			name: "Admin test project",
			status: "active",
			createdAt: at,
			updatedAt: at,
		})
		.onConflictDoNothing({ target: projects.id });
}

export function uniqueUsername(prefix = "user"): string {
	return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

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
