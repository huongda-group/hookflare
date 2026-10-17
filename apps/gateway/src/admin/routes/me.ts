import { changePasswordRequest, type Me } from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { auditInsertIfChanged } from "../../core/audit";
import { users } from "../../core/db/schema";
import { deleteUserSessionsStmt } from "../../core/db/sessions";
import { getUser } from "../../core/db/users";
import { permissionsOf } from "../../core/rbac";
import { hashPassword, verifyPassword } from "../auth/password";
import { readJson } from "../http";

/** Any active user; the dashboard uses it to show or hide actions (spec §12). */
export function meRoutes() {
	const routes = new Hono<AppBindings>();
	routes.get("/", (c) => {
		const actor = c.var.actor;
		if (!actor) return c.json({ error: "forbidden" }, 403);
		return c.json({
			username: actor.username,
			role: actor.role,
			permissions: permissionsOf(actor.role),
		} satisfies Me);
	});

	// Any logged-in user changes their own password (spec §6.6).
	routes.post("/password", async (c) => {
		const actor = c.var.actor;
		if (!actor) return c.json({ error: "forbidden" }, 403);
		const body = await readJson(c, changePasswordRequest);
		if (!body.ok) return body.response;
		const { db, now } = c.var.deps;
		const { current_password, new_password } = body.value;
		const existing = await getUser(db, actor.username);
		// A wrong current password writes nothing (not even an audit row).
		if (
			!existing ||
			!(await verifyPassword(current_password, existing.passwordHash))
		) {
			return c.json({ error: "wrong_password" }, 401);
		}
		if (new_password === actor.username) {
			return c.json({ error: "password_equals_username" }, 400);
		}
		const ts = now();
		const passwordHash = await hashPassword(new_password);
		// A cookie caller keeps the session that made the change; a token caller
		// has no `sessionIdHash`, so every session of the user is deleted.
		await db.batch([
			db
				.update(users)
				.set({ passwordHash, passwordChangedAt: ts, updatedAt: ts })
				.where(eq(users.username, actor.username)),
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
		return c.body(null, 204);
	});

	return routes;
}
