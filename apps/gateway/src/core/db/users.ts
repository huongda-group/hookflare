import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../../deps";
import { auditInsert } from "../audit";
import { type Role, type UserRow, users } from "./schema";

export async function getUser(
	db: Db,
	email: string,
): Promise<UserRow | undefined> {
	return db.select().from(users).where(eq(users.email, email)).get();
}

/**
 * Spec M3-8. ON CONFLICT DO NOTHING keeps an existing row (including a
 * disabled or demoted one) untouched: the env var only seeds.
 */
export function bootstrapStatements(db: Db, email: string, now: number) {
	return [
		db
			.insert(users)
			.values({ email, role: "admin", createdAt: now, updatedAt: now })
			.onConflictDoNothing(),
		auditInsert(db, {
			actor: email,
			action: "user.bootstrapped",
			resourceType: "user",
			resourceId: email,
			at: now,
		}),
	] as const;
}

export async function listUsers(
	db: Db,
	opts: { after?: string; limit: number },
): Promise<UserRow[]> {
	return db
		.select()
		.from(users)
		.where(opts.after ? gt(users.email, opts.after) : undefined)
		.orderBy(asc(users.email))
		.limit(opts.limit + 1)
		.all();
}

/**
 * Spec M3-9: the UPDATE matches no row if, afterwards, no active admin
 * would remain. One statement, so two concurrent demotions cannot both pass.
 */
export function updateUserStmt(
	db: Db,
	email: string,
	set: { role?: Role; disabledAt?: number | null; updatedAt: number },
) {
	const stillAdmin =
		(set.role === undefined || set.role === "admin") && set.disabledAt == null;
	return db
		.update(users)
		.set(set)
		.where(
			and(
				eq(users.email, email),
				stillAdmin
					? undefined
					: sql`(SELECT count(*) FROM users WHERE role = 'admin' AND disabled_at IS NULL AND email <> ${email}) > 0`,
			),
		)
		.returning();
}
