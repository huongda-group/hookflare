import { and, desc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../../deps";
import { newId } from "../ids";
import {
	type ApiTokenRow,
	apiTokens,
	auditLogs,
	type Role,
	users,
} from "./schema";

export type TokenActor = {
	username: string;
	role: Role;
	tokenId: string;
	lastUsedAt: number | null;
};

/** Unexecuted, so a creation can insert the token and its audit row in one batch. */
export function insertApiTokenStmt(db: Db, row: ApiTokenRow) {
	return db.insert(apiTokens).values(row);
}

/**
 * Resolves a Bearer token to its user. The user row is read per request, so a
 * disabled user's tokens stop working immediately (spec §6.9).
 */
export async function findTokenActor(
	db: Db,
	tokenHash: string,
	now: number,
): Promise<TokenActor | undefined> {
	return db
		.select({
			username: apiTokens.username,
			role: users.role,
			tokenId: apiTokens.id,
			lastUsedAt: apiTokens.lastUsedAt,
		})
		.from(apiTokens)
		.innerJoin(users, eq(users.username, apiTokens.username))
		.where(
			and(
				eq(apiTokens.tokenHash, tokenHash),
				isNull(apiTokens.revokedAt),
				or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
				isNull(users.disabledAt),
				isNotNull(users.passwordHash),
			),
		)
		.get();
}

export function touchApiTokenStmt(db: Db, id: string, now: number) {
	return db
		.update(apiTokens)
		.set({ lastUsedAt: now })
		.where(eq(apiTokens.id, id));
}

/** Newest first; revoked and expired rows stay visible to the UI. */
export async function listApiTokens(
	db: Db,
	username: string,
): Promise<ApiTokenRow[]> {
	return db
		.select()
		.from(apiTokens)
		.where(eq(apiTokens.username, username))
		.orderBy(desc(apiTokens.createdAt), desc(apiTokens.id))
		.all();
}

/**
 * Unexecuted; `.returning()` yields a row only when it was not already revoked,
 * so the route can tell "just revoked" from "was already revoked" (404).
 */
export function revokeApiTokenStmt(
	db: Db,
	username: string,
	id: string,
	now: number,
) {
	return db
		.update(apiTokens)
		.set({ revokedAt: now })
		.where(
			and(
				eq(apiTokens.id, id),
				eq(apiTokens.username, username),
				isNull(apiTokens.revokedAt),
			),
		)
		.returning();
}

/** Unexecuted; revokes every live token of a user, for an admin password reset. */
export function revokeUserApiTokensStmt(db: Db, username: string, now: number) {
	return db
		.update(apiTokens)
		.set({ revokedAt: now })
		.where(and(eq(apiTokens.username, username), isNull(apiTokens.revokedAt)));
}

/**
 * Unexecuted pair for a user disable, in the same batch as (and after) the
 * user update that sets `disabled_at = now`: the revoke applies only if that
 * update did, and the audit row — written only when a token was revoked —
 * lists the IDs read back from the rows it revoked (never a token or hash).
 */
export function revokeDisabledUserApiTokensStmts(
	db: Db,
	a: { username: string; now: number; actor: string; reason: string | null },
) {
	return [
		db
			.update(apiTokens)
			.set({ revokedAt: a.now })
			.where(
				and(
					eq(apiTokens.username, a.username),
					isNull(apiTokens.revokedAt),
					sql`EXISTS (SELECT 1 FROM users WHERE username = ${a.username} AND disabled_at = ${a.now})`,
				),
			),
		db.insert(auditLogs).select(
			db
				.select({
					id: sql<string>`${newId("aud", a.now)}`.as("id"),
					actor: sql<string>`${a.actor}`.as("actor"),
					action: sql<string>`'api_token.revoked'`.as("action"),
					resourceType: sql<string>`'user'`.as("resource_type"),
					resourceId: sql<string>`${a.username}`.as("resource_id"),
					reason: sql<string | null>`${a.reason}`.as("reason"),
					diffJson:
						sql<string>`json_object('revoked_ids', (SELECT json_group_array(id) FROM (SELECT id FROM api_tokens WHERE username = ${a.username} AND revoked_at = ${a.now} ORDER BY id)), 'cause', 'user.disabled')`.as(
							"diff_json",
						),
					at: sql<number>`${a.now}`.as("at"),
				})
				.from(sql`(SELECT 1)`)
				.where(sql`changes() > 0`),
		),
	] as const;
}
