import { changePasswordRequest, type Me } from "@hookflare/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { auditInsertIfChanged } from "../../core/audit";
import { hasProject } from "../../core/db/projects";
import { users } from "../../core/db/schema";
import { deleteUserSessionsStmt } from "../../core/db/sessions";
import { getUser } from "../../core/db/users";
import { permissionsOf } from "../../core/rbac";
import { hashPassword, verifyPassword } from "../auth/password";
import { readJson } from "../http";

export function meRoutes() {
	const routes = new Hono<AppBindings>();
	routes.get("/", async (c) => {
		const actor = c.var.actor;
		if (!actor) return c.json({ error: "forbidden" }, 403);
		return c.json({
			username: actor.username,
			role: actor.role,
			permissions: permissionsOf(actor.role),
			project_required: !(await hasProject(c.var.deps.db)),
		} satisfies Me);
	});

	routes.post("/password", async (c) => {
		const actor = c.var.actor;
		if (!actor) return c.json({ error: "forbidden" }, 403);
		const body = await readJson(c, changePasswordRequest);
		if (!body.ok) return body.response;
		const { db, now } = c.var.deps;
		const { current_password, new_password } = body.value;
		const { success } = await c.env.LOGIN_LIMITER.limit({
			key: `password:${actor.username}`,
		});
		if (!success) return c.json({ error: "too_many_attempts" }, 429);
		const existing = await getUser(db, actor.username);
		const currentHash = existing?.passwordHash;
		if (
			!currentHash ||
			!(await verifyPassword(current_password, currentHash))
		) {
			return c.json({ error: "wrong_password" }, 401);
		}
		if (new_password === actor.username) {
			return c.json({ error: "password_equals_username" }, 400);
		}
		const ts = now();
		const passwordHash = await hashPassword(new_password);
		const [updated] = await db.batch([
			db
				.update(users)
				.set({ passwordHash, passwordChangedAt: ts, updatedAt: ts })
				.where(
					and(
						eq(users.username, actor.username),
						eq(users.passwordHash, currentHash),
					),
				),
			auditInsertIfChanged(db, {
				actor: actor.username,
				action: "user.password_changed",
				resourceType: "user",
				resourceId: actor.username,
				diff: {},
				at: ts,
			}),
			deleteUserSessionsStmt(db, actor.username, actor.sessionIdHash),
		]);
		if (updated.meta.changes === 0) {
			return c.json({ error: "wrong_password" }, 401);
		}
		return c.body(null, 204);
	});

	return routes;
}
