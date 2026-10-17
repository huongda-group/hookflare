import {
	createUserRequest,
	type Page,
	pageQuery,
	patchUserRequest,
	resetPasswordRequest,
	type User,
} from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { type AuditAction, auditInsertIfChanged } from "../../core/audit";
import { isUniqueViolation } from "../../core/db/errors";
import type { UserRow } from "../../core/db/schema";
import { users } from "../../core/db/schema";
import { deleteUserSessionsStmt } from "../../core/db/sessions";
import { getUser, listUsers, updateUserStmt } from "../../core/db/users";
import { hashPassword } from "../auth/password";
import { requirePermission } from "../auth/permission";
import { auditStmt, readJson, readQuery } from "../http";
import { apiTokenRoutes } from "./api-tokens";

function toUser(r: UserRow): User {
	return {
		username: r.username,
		role: r.role,
		created_at: r.createdAt,
		updated_at: r.updatedAt,
		disabled_at: r.disabledAt,
		has_password: r.passwordHash !== null,
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
				rows.length > q.value.limit ? (page.at(-1)?.username ?? null) : null,
		} satisfies Page<User>);
	});

	routes.post("/", guard, async (c) => {
		const body = await readJson(c, createUserRequest);
		if (!body.ok) return body.response;
		const { db, now } = c.var.deps;
		const ts = now();
		const { reason, ...v } = body.value;
		if (v.password === v.username) {
			return c.json({ error: "password_equals_username" }, 400);
		}
		const passwordHash = await hashPassword(v.password);
		const row: UserRow = {
			username: v.username,
			role: v.role,
			passwordHash,
			passwordChangedAt: ts,
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
					resourceId: v.username,
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

	routes.patch("/:username", guard, async (c) => {
		const body = await readJson(c, patchUserRequest);
		if (!body.ok) return body.response;
		const { db, now } = c.var.deps;
		const username = c.req.param("username").trim().toLowerCase();
		const existing = await getUser(db, username);
		if (!existing) return c.json({ error: "not_found" }, 404);
		const { role, disabled, reason } = body.value;
		if (disabled === true && username === c.var.actor?.username) {
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
		const update = updateUserStmt(db, username, set);
		const audit = auditInsertIfChanged(db, {
			actor: c.var.actor?.username ?? "",
			action,
			resourceType: "user",
			resourceId: username,
			reason,
			diff: {
				...(role !== undefined
					? { role: { from: existing.role, to: role } }
					: {}),
				...(disabled !== undefined ? { disabled } : {}),
			},
			at: ts,
		});
		// Disabling revokes the user's sessions in the same batch (spec §6.6).
		const [[row]] =
			disabled === true
				? await db.batch([update, audit, deleteUserSessionsStmt(db, username)])
				: await db.batch([update, audit]);
		if (!row) return c.json({ error: "last_admin" }, 409);
		return c.json(toUser(row));
	});

	routes.post("/:username/password", guard, async (c) => {
		const body = await readJson(c, resetPasswordRequest);
		if (!body.ok) return body.response;
		const { db, now } = c.var.deps;
		const username = c.req.param("username").trim().toLowerCase();
		const existing = await getUser(db, username);
		if (!existing) return c.json({ error: "not_found" }, 404);
		const { password, reason } = body.value;
		if (password === username) {
			return c.json({ error: "password_equals_username" }, 400);
		}
		const ts = now();
		const passwordHash = await hashPassword(password);
		// Reset and session revocation are one atomic batch (spec §6.6); the audit
		// diff carries no password or hash.
		await db.batch([
			db
				.update(users)
				.set({ passwordHash, passwordChangedAt: ts, updatedAt: ts })
				.where(eq(users.username, username)),
			auditInsertIfChanged(db, {
				actor: c.var.actor?.username ?? "",
				action: "user.password_reset",
				resourceType: "user",
				resourceId: username,
				reason,
				diff: {},
				at: ts,
			}),
			deleteUserSessionsStmt(db, username),
		]);
		return c.body(null, 204);
	});

	routes.route("/:username/tokens", apiTokenRoutes());

	return routes;
}
