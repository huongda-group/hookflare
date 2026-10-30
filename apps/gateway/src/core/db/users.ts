import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../../deps";
import { type Role, type UserRow, users } from "./schema";

export async function getUser(
	db: Db,
	username: string,
): Promise<UserRow | undefined> {
	return db.select().from(users).where(eq(users.username, username)).get();
}

export async function listUsers(
	db: Db,
	opts: { after?: string; limit: number },
): Promise<UserRow[]> {
	return db
		.select()
		.from(users)
		.where(opts.after ? gt(users.username, opts.after) : undefined)
		.orderBy(asc(users.username))
		.limit(opts.limit + 1)
		.all();
}

/**
 * Spec M3-9: the UPDATE matches no row if, afterwards, no active admin
 * would remain. Only an admin who can log in (has a password) counts, so a
 * migrated password-less admin row cannot mask a lockout. One statement, so two concurrent demotions cannot both pass.
 */
export function updateUserStmt(
	db: Db,
	username: string,
	set: { role?: Role; disabledAt?: number | null; updatedAt: number },
) {
	const stillAdmin =
		(set.role === undefined || set.role === "admin") && set.disabledAt == null;
	return db
		.update(users)
		.set(set)
		.where(
			and(
				eq(users.username, username),
				stillAdmin
					? undefined
					: sql`(SELECT count(*) FROM users WHERE role = 'admin' AND disabled_at IS NULL AND password_hash IS NOT NULL AND username <> ${username}) > 0`,
			),
		)
		.returning();
}
