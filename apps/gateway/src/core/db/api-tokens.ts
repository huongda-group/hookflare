import { and, desc, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import type { Db } from "../../deps";
import { type ApiTokenRow, apiTokens, type Role, users } from "./schema";

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
