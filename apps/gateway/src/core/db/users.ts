import { eq } from "drizzle-orm";
import type { Db } from "../../deps";
import { auditInsert } from "../audit";
import { type UserRow, users } from "./schema";

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
