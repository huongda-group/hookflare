import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessions, users } from "../../../src/core/db/schema";
import {
	deleteSessionStmt,
	deleteUserSessionsStmt,
	findSessionActor,
	insertSessionStmt,
	purgeExpiredSessions,
	SESSION_ABSOLUTE_MS,
	SESSION_IDLE_MS,
	SESSION_TOUCH_MS,
	touchSessionStmt,
} from "../../../src/core/db/sessions";
import type { Deps } from "../../../src/deps";
import { testDeps } from "../../helpers/deps";

const T0 = 1_800_000_000_000;
/** Only "IS NOT NULL" matters here; the value itself is never parsed. */
const PASSWORD_HASH = "pbkdf2-sha256$100000$c2FsdA==$aGFzaA==";

function clock(now = T0) {
	return testDeps({ now: () => now });
}

/** Storage may be shared across a file, so keys are unique per test. */
function uid(prefix = "u") {
	return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function seedUser(
	deps: Deps,
	username: string,
	overrides: Partial<typeof users.$inferInsert> = {},
) {
	await deps.db.insert(users).values({
		username,
		role: "admin",
		passwordHash: PASSWORD_HASH,
		passwordChangedAt: null,
		createdAt: T0,
		updatedAt: T0,
		disabledAt: null,
		...overrides,
	});
}

describe("findSessionActor", () => {
	it("finds a live session and returns its user", async () => {
		const deps = clock();
		const username = uid();
		const idHash = uid("h");
		await seedUser(deps, username, { role: "operator" });
		await insertSessionStmt(deps.db, { idHash, username, now: T0 });

		const [row] = await deps.db
			.select()
			.from(sessions)
			.where(eq(sessions.idHash, idHash));
		// Fresh sessions expire on the idle timeout, the earlier of the two.
		expect(row?.expiresAt).toBe(T0 + SESSION_IDLE_MS);

		expect(await findSessionActor(deps.db, idHash, T0)).toEqual({
			username,
			role: "operator",
			createdAt: T0,
			lastSeenAt: T0,
		});
	});

	it("stops finding a session 12 h after the last touch", async () => {
		const deps = clock();
		const username = uid();
		const idHash = uid("h");
		await seedUser(deps, username);
		await insertSessionStmt(deps.db, { idHash, username, now: T0 });

		expect(
			await findSessionActor(deps.db, idHash, T0 + SESSION_IDLE_MS - 1),
		).toBeDefined();
		expect(
			await findSessionActor(deps.db, idHash, T0 + SESSION_IDLE_MS),
		).toBeUndefined();
	});

	it("never lets a touch push a session past 7 d", async () => {
		const deps = clock();
		const username = uid();
		const idHash = uid("h");
		await seedUser(deps, username);
		await insertSessionStmt(deps.db, { idHash, username, now: T0 });

		// Touch every 5 min for the whole absolute lifetime.
		for (
			let t = T0 + SESSION_TOUCH_MS;
			t <= T0 + SESSION_ABSOLUTE_MS;
			t += SESSION_TOUCH_MS
		) {
			await touchSessionStmt(deps.db, idHash, T0, t);
		}

		expect(
			await findSessionActor(deps.db, idHash, T0 + SESSION_ABSOLUTE_MS - 1),
		).toBeDefined();
		expect(
			await findSessionActor(deps.db, idHash, T0 + SESSION_ABSOLUTE_MS),
		).toBeUndefined();

		const [row] = await deps.db
			.select()
			.from(sessions)
			.where(eq(sessions.idHash, idHash));
		expect(row?.lastSeenAt).toBe(T0 + SESSION_ABSOLUTE_MS);
		expect(row?.expiresAt).toBe(T0 + SESSION_ABSOLUTE_MS);
	});

	it("requires an enabled user with a password", async () => {
		const deps = clock();
		const disabled = uid();
		const passwordless = uid();
		await seedUser(deps, disabled, { disabledAt: T0 });
		await seedUser(deps, passwordless, { passwordHash: null });
		const hDisabled = uid("h");
		const hNoPw = uid("h");
		await insertSessionStmt(deps.db, {
			idHash: hDisabled,
			username: disabled,
			now: T0,
		});
		await insertSessionStmt(deps.db, {
			idHash: hNoPw,
			username: passwordless,
			now: T0,
		});

		expect(await findSessionActor(deps.db, hDisabled, T0)).toBeUndefined();
		expect(await findSessionActor(deps.db, hNoPw, T0)).toBeUndefined();
	});
});

describe("deleteSessionStmt", () => {
	it("deletes one session by id hash", async () => {
		const deps = clock();
		const username = uid();
		const idHash = uid("h");
		await seedUser(deps, username);
		await insertSessionStmt(deps.db, { idHash, username, now: T0 });

		const result = await deleteSessionStmt(deps.db, idHash);
		expect(result.meta.changes).toBe(1);
		expect(await findSessionActor(deps.db, idHash, T0)).toBeUndefined();
	});
});

describe("deleteUserSessionsStmt", () => {
	it("keeps the excepted session and touches no other user", async () => {
		const deps = clock();
		const username = uid();
		const other = uid();
		await seedUser(deps, username);
		await seedUser(deps, other);
		const keep = uid("h");
		const drop = uid("h");
		const foreign = uid("h");
		await insertSessionStmt(deps.db, { idHash: keep, username, now: T0 });
		await insertSessionStmt(deps.db, { idHash: drop, username, now: T0 });
		await insertSessionStmt(deps.db, {
			idHash: foreign,
			username: other,
			now: T0,
		});

		const result = await deleteUserSessionsStmt(deps.db, username, keep);
		expect(result.meta.changes).toBe(1);
		expect(await findSessionActor(deps.db, keep, T0)).toBeDefined();
		expect(await findSessionActor(deps.db, drop, T0)).toBeUndefined();
		expect(await findSessionActor(deps.db, foreign, T0)).toBeDefined();
	});

	it("deletes every session when nothing is excepted", async () => {
		const deps = clock();
		const username = uid();
		await seedUser(deps, username);
		const a = uid("h");
		const b = uid("h");
		await insertSessionStmt(deps.db, { idHash: a, username, now: T0 });
		await insertSessionStmt(deps.db, { idHash: b, username, now: T0 });

		const result = await deleteUserSessionsStmt(deps.db, username);
		expect(result.meta.changes).toBe(2);
		expect(await findSessionActor(deps.db, a, T0)).toBeUndefined();
		expect(await findSessionActor(deps.db, b, T0)).toBeUndefined();
	});
});

describe("purgeExpiredSessions", () => {
	it("deletes at most `limit` expired sessions", async () => {
		const deps = clock();
		const username = uid();
		await seedUser(deps, username);
		const expired = (i: number) => ({
			idHash: uid(`exp${i}`),
			username,
			createdAt: T0 - 1_000,
			lastSeenAt: T0 - 1_000,
			expiresAt: T0 - 1,
		});
		await deps.db
			.insert(sessions)
			.values([expired(0), expired(1), expired(2), expired(3), expired(4)]);
		const live = uid("live");
		await insertSessionStmt(deps.db, { idHash: live, username, now: T0 });

		expect(await purgeExpiredSessions(deps.db, T0, 3)).toBe(3);
		const afterFirst = await deps.db
			.select()
			.from(sessions)
			.where(eq(sessions.username, username));
		expect(afterFirst).toHaveLength(3);
		expect(afterFirst.filter((r) => r.idHash === live)).toHaveLength(1);
		expect(afterFirst.filter((r) => r.expiresAt <= T0)).toHaveLength(2);

		// The next pass drains the rest, then reports nothing left.
		expect(await purgeExpiredSessions(deps.db, T0, 3)).toBe(2);
		expect(await purgeExpiredSessions(deps.db, T0, 3)).toBe(0);
		expect(await findSessionActor(deps.db, live, T0)).toBeDefined();
	});
});

describe("cascade", () => {
	it("removes a user's sessions when the user is deleted", async () => {
		const deps = clock();
		const username = uid();
		const idHash = uid("h");
		await seedUser(deps, username);
		await insertSessionStmt(deps.db, { idHash, username, now: T0 });

		await deps.db.delete(users).where(eq(users.username, username));
		const rows = await deps.db
			.select()
			.from(sessions)
			.where(eq(sessions.username, username));
		expect(rows).toHaveLength(0);
	});
});
