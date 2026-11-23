import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
	findTokenActor,
	insertApiTokenStmt,
	listApiTokens,
	revokeApiTokenStmt,
	touchApiTokenStmt,
} from "../../../src/core/db/api-tokens";
import {
	type ApiTokenRow,
	apiTokens,
	users,
} from "../../../src/core/db/schema";
import { newId } from "../../../src/core/ids";
import type { Deps } from "../../../src/deps";
import { testDeps } from "../../helpers/deps";

const T0 = 1_800_000_000_000;
/** Only "IS NOT NULL" matters here; the value itself is never parsed. */
const PASSWORD_HASH = "pbkdf2-sha256$100000$c2FsdA==$aGFzaA==";

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

function token(overrides: Partial<ApiTokenRow> = {}): ApiTokenRow {
	return {
		id: newId("tok", T0),
		tokenHash: uid("hash"),
		username: "",
		name: "ci",
		createdAt: T0,
		expiresAt: null,
		lastUsedAt: null,
		revokedAt: null,
		...overrides,
	};
}

describe("findTokenActor", () => {
	it("finds a live token and returns its user", async () => {
		const deps = testDeps({ now: () => T0 });
		const username = uid();
		await seedUser(deps, username, { role: "operator" });
		const row = token({ username });
		await insertApiTokenStmt(deps.db, row);

		expect(await findTokenActor(deps.db, row.tokenHash, T0)).toEqual({
			username,
			role: "operator",
			tokenId: row.id,
			lastUsedAt: null,
		});
	});

	it("stops finding a token at its expiry", async () => {
		const deps = testDeps({ now: () => T0 });
		const username = uid();
		await seedUser(deps, username);
		const row = token({ username, expiresAt: T0 + 1_000 });
		await insertApiTokenStmt(deps.db, row);

		expect(
			await findTokenActor(deps.db, row.tokenHash, T0 + 999),
		).toBeDefined();
		expect(
			await findTokenActor(deps.db, row.tokenHash, T0 + 1_000),
		).toBeUndefined();
	});

	it("does not find a revoked token", async () => {
		const deps = testDeps({ now: () => T0 });
		const username = uid();
		await seedUser(deps, username);
		const row = token({ username, revokedAt: T0 - 1 });
		await insertApiTokenStmt(deps.db, row);

		expect(await findTokenActor(deps.db, row.tokenHash, T0)).toBeUndefined();
	});

	it("requires an enabled user with a password", async () => {
		const deps = testDeps({ now: () => T0 });
		const disabled = uid();
		const passwordless = uid();
		await seedUser(deps, disabled, { disabledAt: T0 });
		await seedUser(deps, passwordless, { passwordHash: null });
		const a = token({ username: disabled });
		const b = token({ username: passwordless });
		await insertApiTokenStmt(deps.db, a);
		await insertApiTokenStmt(deps.db, b);

		expect(await findTokenActor(deps.db, a.tokenHash, T0)).toBeUndefined();
		expect(await findTokenActor(deps.db, b.tokenHash, T0)).toBeUndefined();
	});
});

describe("touchApiTokenStmt", () => {
	it("records last_used_at", async () => {
		const deps = testDeps({ now: () => T0 });
		const username = uid();
		await seedUser(deps, username);
		const row = token({ username });
		await insertApiTokenStmt(deps.db, row);

		await touchApiTokenStmt(deps.db, row.id, T0 + 5_000);
		const [found] = await deps.db
			.select()
			.from(apiTokens)
			.where(eq(apiTokens.id, row.id));
		expect(found?.lastUsedAt).toBe(T0 + 5_000);
		expect((await findTokenActor(deps.db, row.tokenHash, T0))?.lastUsedAt).toBe(
			T0 + 5_000,
		);
	});
});

describe("listApiTokens", () => {
	it("lists only that user's tokens, newest first", async () => {
		const deps = testDeps({ now: () => T0 });
		const username = uid();
		const other = uid();
		await seedUser(deps, username);
		await seedUser(deps, other);
		await insertApiTokenStmt(
			deps.db,
			token({ username, name: "old", createdAt: T0 }),
		);
		await insertApiTokenStmt(
			deps.db,
			token({ username, name: "new", createdAt: T0 + 1_000 }),
		);
		await insertApiTokenStmt(
			deps.db,
			token({ username: other, name: "other" }),
		);

		const rows = await listApiTokens(deps.db, username);
		expect(rows.map((r) => r.name)).toEqual(["new", "old"]);
	});
});

describe("revokeApiTokenStmt", () => {
	it("revokes a live token once and reports a repeat revoke", async () => {
		const deps = testDeps({ now: () => T0 });
		const username = uid();
		const other = uid();
		await seedUser(deps, username);
		await seedUser(deps, other);
		const row = token({ username });
		await insertApiTokenStmt(deps.db, row);

		// Another owner cannot revoke it: the update matches nothing.
		const [[wrongOwner]] = await deps.db.batch([
			revokeApiTokenStmt(deps.db, other, row.id, T0),
		]);
		expect(wrongOwner).toBeUndefined();
		expect(await findTokenActor(deps.db, row.tokenHash, T0)).toBeDefined();

		const [[revoked]] = await deps.db.batch([
			revokeApiTokenStmt(deps.db, username, row.id, T0 + 1),
		]);
		expect(revoked).toMatchObject({ id: row.id, revokedAt: T0 + 1 });
		expect(
			await findTokenActor(deps.db, row.tokenHash, T0 + 2),
		).toBeUndefined();

		const [[again]] = await deps.db.batch([
			revokeApiTokenStmt(deps.db, username, row.id, T0 + 2),
		]);
		expect(again).toBeUndefined();
	});
});

describe("cascade", () => {
	it("removes a user's tokens when the user is deleted", async () => {
		const deps = testDeps({ now: () => T0 });
		const username = uid();
		await seedUser(deps, username);
		await insertApiTokenStmt(deps.db, token({ username }));

		await deps.db.delete(users).where(eq(users.username, username));
		const rows = await deps.db
			.select()
			.from(apiTokens)
			.where(eq(apiTokens.username, username));
		expect(rows).toHaveLength(0);
	});
});
