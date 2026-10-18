import { and, eq, gt, inArray, isNotNull, isNull, lte, ne } from "drizzle-orm";
import type { Db } from "../../deps";
import { type Role, sessions, users } from "./schema";

export const SESSION_IDLE_MS = 12 * 3600_000;
export const SESSION_ABSOLUTE_MS = 7 * 86_400_000;
/** Re-touch a session at most this often, to bound D1 writes (spec §6.4). */
export const SESSION_TOUCH_MS = 5 * 60_000;

export type SessionActor = {
	username: string;
	role: Role;
	createdAt: number;
	lastSeenAt: number;
};

/**
 * Folds both limits into one `expires_at`: the session dies 12 h after its last
 * activity or 7 d after creation, whichever comes first. Every read and the
 * cleanup job then need only one comparison.
 */
function sessionExpiry(createdAt: number, now: number): number {
	return Math.min(createdAt + SESSION_ABSOLUTE_MS, now + SESSION_IDLE_MS);
}

/** Unexecuted, so a login can insert it and the audit row in one batch. */
export function insertSessionStmt(
	db: Db,
	s: { idHash: string; username: string; now: number },
) {
	return db.insert(sessions).values({
		idHash: s.idHash,
		username: s.username,
		createdAt: s.now,
		lastSeenAt: s.now,
		expiresAt: sessionExpiry(s.now, s.now),
	});
}

/**
 * One query joining the user, so disabling/demoting a user or clearing their
 * password takes effect on the very next request (spec §6.4).
 */
export async function findSessionActor(
	db: Db,
	idHash: string,
	now: number,
): Promise<SessionActor | undefined> {
	return db
		.select({
			username: sessions.username,
			role: users.role,
			createdAt: sessions.createdAt,
			lastSeenAt: sessions.lastSeenAt,
		})
		.from(sessions)
		.innerJoin(users, eq(users.username, sessions.username))
		.where(
			and(
				eq(sessions.idHash, idHash),
				gt(sessions.expiresAt, now),
				isNull(users.disabledAt),
				isNotNull(users.passwordHash),
			),
		)
		.get();
}

/**
 * `createdAt` is the session's original creation, so repeated touches move the
 * idle deadline but can never push it past the 7 d absolute cap.
 */
export function touchSessionStmt(
	db: Db,
	idHash: string,
	createdAt: number,
	now: number,
) {
	return db
		.update(sessions)
		.set({ lastSeenAt: now, expiresAt: sessionExpiry(createdAt, now) })
		.where(eq(sessions.idHash, idHash));
}

export function deleteSessionStmt(db: Db, idHash: string) {
	return db.delete(sessions).where(eq(sessions.idHash, idHash));
}

/**
 * Deletes a user's sessions, optionally keeping the caller's own (password
 * change/reset keeps the current session; disabling keeps none).
 */
export function deleteUserSessionsStmt(
	db: Db,
	username: string,
	exceptIdHash?: string,
) {
	return db
		.delete(sessions)
		.where(
			and(
				eq(sessions.username, username),
				exceptIdHash ? ne(sessions.idHash, exceptIdHash) : undefined,
			),
		);
}

/**
 * Per-minute cleanup (spec §6.4). D1 rejects `DELETE … LIMIT`, so the bound is
 * a subquery; returns how many rows were removed.
 */
export async function purgeExpiredSessions(
	db: Db,
	now: number,
	limit = 500,
): Promise<number> {
	const expired = db
		.select({ idHash: sessions.idHash })
		.from(sessions)
		.where(lte(sessions.expiresAt, now))
		.limit(limit);
	const result = await db
		.delete(sessions)
		.where(inArray(sessions.idHash, expired));
	return result.meta.changes;
}
