import {
	createUserRequest,
	type Page,
	pageQuery,
	patchUserRequest,
	type User,
} from "@hookflare/shared";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { type AuditAction, auditInsertIfChanged } from "../../core/audit";
import { isUniqueViolation } from "../../core/db/errors";
import type { UserRow } from "../../core/db/schema";
import { users } from "../../core/db/schema";
import { getUser, listUsers, updateUserStmt } from "../../core/db/users";
import { requirePermission } from "../auth/permission";
import { auditStmt, readJson, readQuery } from "../http";

function toUser(r: UserRow): User {
	return {
		email: r.email,
		role: r.role,
		created_at: r.createdAt,
		updated_at: r.updatedAt,
		disabled_at: r.disabledAt,
	};
}

export function userRoutes() {
	const routes = new Hono<AppBindings>();
	const guard = requirePermission("users.manage");

	routes.get("/", guard, async (c) => {
		const q = readQuery(c, pageQuery);
		if (!q.ok) return q.response;
		const rows = await listUsers(c.var.deps.db, {
			after: q.value.cursor,
			limit: q.value.limit,
		});
		const page = rows.slice(0, q.value.limit);
		return c.json({
			data: page.map(toUser),
			next_cursor:
				rows.length > q.value.limit ? (page.at(-1)?.email ?? null) : null,
		} satisfies Page<User>);
	});

	routes.post("/", guard, async (c) => {
		const body = await readJson(c, createUserRequest);
		if (!body.ok) return body.response;
		const { db, now } = c.var.deps;
		const ts = now();
		const { reason, ...v } = body.value;
		const row: UserRow = {
			email: v.email,
			role: v.role,
			createdAt: ts,
			updatedAt: ts,
			disabledAt: null,
		};
		try {
			await db.batch([
				db.insert(users).values(row),
				auditStmt(c, {
					action: "user.created",
					resourceType: "user",
					resourceId: v.email,
					reason,
					diff: { role: v.role },
				}),
			]);
		} catch (err) {
			if (isUniqueViolation(err)) return c.json({ error: "user_exists" }, 409);
			throw err;
		}
		return c.json(toUser(row), 201);
	});

	routes.patch("/:email", guard, async (c) => {
		const body = await readJson(c, patchUserRequest);
		if (!body.ok) return body.response;
		const { db, now } = c.var.deps;
		const email = decodeURIComponent(c.req.param("email")).trim().toLowerCase();
		const existing = await getUser(db, email);
		if (!existing) return c.json({ error: "not_found" }, 404);
		const { role, disabled, reason } = body.value;
		if (disabled === true && email === c.var.actor?.email) {
			return c.json({ error: "self_disable" }, 409);
		}
		// Like a repeat Pause: nothing changes, so nothing is written or audited.
		const sameRole = role === undefined || role === existing.role;
		const sameState =
			disabled === undefined || disabled === (existing.disabledAt !== null);
		if (sameRole && sameState) return c.json(toUser(existing));
		const ts = now();
		const action: AuditAction =
			disabled === true
				? "user.disabled"
				: disabled === false
					? "user.enabled"
					: "user.role_changed";
		const set = {
			...(role !== undefined ? { role } : {}),
			...(disabled !== undefined ? { disabledAt: disabled ? ts : null } : {}),
			updatedAt: ts,
		};
		const [[row]] = await db.batch([
			updateUserStmt(db, email, set),
			auditInsertIfChanged(db, {
				actor: c.var.actor?.email ?? "",
				action,
				resourceType: "user",
				resourceId: email,
				reason,
				diff: {
					...(role !== undefined
						? { role: { from: existing.role, to: role } }
						: {}),
					...(disabled !== undefined ? { disabled } : {}),
				},
				at: ts,
			}),
		]);
		if (!row) return c.json({ error: "last_admin" }, 409);
		return c.json(toUser(row));
	});

	return routes;
}
