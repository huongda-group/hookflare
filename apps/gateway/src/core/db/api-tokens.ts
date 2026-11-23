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

export function insertApiTokenStmt(db: Db, row: ApiTokenRow) {
	return db.insert(apiTokens).values(row);
}

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

export function revokeUserApiTokensStmt(db: Db, username: string, now: number) {
	return db
		.update(apiTokens)
		.set({ revokedAt: now })
		.where(and(eq(apiTokens.username, username), isNull(apiTokens.revokedAt)));
}

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
