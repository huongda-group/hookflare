import {
	type ApiToken,
	type CreatedApiToken,
	createApiTokenRequest,
} from "@hookflare/shared";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { auditInsertIfChanged } from "../../core/audit";
import {
	insertApiTokenStmt,
	listApiTokens,
	revokeApiTokenStmt,
} from "../../core/db/api-tokens";
import type { ApiTokenRow } from "../../core/db/schema";
import { getUser } from "../../core/db/users";
import { newId } from "../../core/ids";
import { requirePermission } from "../auth/permission";
import { randomToken, sha256Hex } from "../auth/secrets";
import { auditStmt, readJson } from "../http";

const DAY_MS = 86_400_000;

/** `token_hash` is deliberately not part of this shape (spec §6.9). */
function toApiToken(r: ApiTokenRow): ApiToken {
	return {
		id: r.id,
		username: r.username,
		name: r.name,
		created_at: r.createdAt,
		expires_at: r.expiresAt,
		last_used_at: r.lastUsedAt,
		revoked_at: r.revokedAt,
	};
}

/**
 * Mounted by `userRoutes()` at `/:username/tokens`, so the parent path supplies
 * the user every operation is scoped to (spec §6.9).
 */
export function apiTokenRoutes() {
	const routes = new Hono<AppBindings>();
	const guard = requirePermission("users.manage");

	routes.get("/", guard, async (c) => {
		const username = (c.req.param("username") ?? "").trim().toLowerCase();
		const rows = await listApiTokens(c.var.deps.db, username);
		return c.json({ data: rows.map(toApiToken) });
	});

	routes.post("/", guard, async (c) => {
		const body = await readJson(c, createApiTokenRequest);
		if (!body.ok) return body.response;
		const { db, now } = c.var.deps;
		const username = (c.req.param("username") ?? "").trim().toLowerCase();
		// A token belongs to an existing user; the FK would otherwise 500.
		const target = await getUser(db, username);
		if (!target) {
			return c.json({ error: "not_found" }, 404);
		}
		// A token for a password-less user could never authenticate:
		// `findTokenActor` requires `password_hash IS NOT NULL`.
		if (target.passwordHash === null) {
			return c.json({ error: "user_has_no_password" }, 409);
		}
		const { name, expires_in_days, reason } = body.value;
		const at = now();
		// The plaintext is returned once; only its SHA-256 hex is stored.
		const token = randomToken("hf_");
		const row: ApiTokenRow = {
			id: newId("tok", at),
			tokenHash: await sha256Hex(token),
			username,
			name,
			createdAt: at,
			expiresAt: expires_in_days ? at + expires_in_days * DAY_MS : null,
			lastUsedAt: null,
			revokedAt: null,
		};
		await db.batch([
			insertApiTokenStmt(db, row),
			auditStmt(c, {
				action: "api_token.created",
				resourceType: "api_token",
				resourceId: row.id,
				reason,
				// Never the token or its hash (spec §6.9).
				diff: { username, name },
			}),
		]);
		return c.json({ ...toApiToken(row), token } satisfies CreatedApiToken, 201);
	});

	routes.post("/:id/revoke", guard, async (c) => {
		const { db, now } = c.var.deps;
		const username = (c.req.param("username") ?? "").trim().toLowerCase();
		const id = c.req.param("id");
		const at = now();
		// The audit is guarded by the revoke's `changes()`,
		// so a no-op revoke writes nothing.
		const [rows] = await db.batch([
			revokeApiTokenStmt(db, username, id, at),
			auditInsertIfChanged(db, {
				actor: c.var.actor?.username ?? "",
				action: "api_token.revoked",
				resourceType: "api_token",
				resourceId: id,
				at,
			}),
		]);
		// No row means already revoked, unknown, or owned by another user.
		if (!rows[0]) return c.json({ error: "not_found" }, 404);
		return c.body(null, 204);
	});

	return routes;
}
