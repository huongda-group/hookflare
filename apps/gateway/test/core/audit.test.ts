import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
	auditInsert,
	auditInsertIfChanged,
	redactDiff,
} from "../../src/core/audit";
import { auditLogs, users } from "../../src/core/db/schema";
import { auditRows, uniqueUsername } from "../helpers/admin";
import { testDeps } from "../helpers/deps";

describe("redactDiff", () => {
	it("drops secret, token, and password keys at any depth and in any case", () => {
		expect(
			redactDiff({
				name: "n",
				secret: "s",
				Signing_Secret: "s",
				nested: { apiToken: "t", keep: 1, list: [{ PASSWORD: "p", ok: true }] },
			}),
		).toEqual({ name: "n", nested: { keep: 1, list: [{ ok: true }] } });
	});

	it("reduces url values to their origin", () => {
		expect(
			redactDiff({ url: "https://user:pw@api.example.com/hooks?key=abc" }),
		).toEqual({ url: "https://api.example.com" });
	});

	it("leaves an unparseable url as a marker, never the raw value", () => {
		expect(redactDiff({ url: "not a url?key=abc" })).toEqual({
			url: "[invalid url]",
		});
	});
});

describe("auditInsert", () => {
	it("writes a redacted row with an aud_ id", async () => {
		const deps = testDeps();
		const at = deps.now();
		await auditInsert(deps.db, {
			actor: "a@example.com",
			action: "project.created",
			resourceType: "project",
			resourceId: "prj_x",
			diff: { name: "n", secret: "s" },
			at,
		});
		const [row] = await deps.db
			.select()
			.from(auditLogs)
			.where(eq(auditLogs.resourceId, "prj_x"));
		expect(row.id).toMatch(/^aud_/);
		expect(row.diffJson).toEqual({ name: "n" });
		expect(row.reason).toBeNull();
		expect(row.at).toBe(at);
	});

	it("auditInsertIfChanged writes only after a changing statement", async () => {
		const deps = testDeps();
		const username = uniqueUsername("chg");
		const now = deps.now();
		const entry = (resourceId: string) => ({
			actor: "t@example.com",
			action: "user.disabled" as const,
			resourceType: "user",
			resourceId,
			at: now,
		});
		await deps.db.batch([
			deps.db
				.update(users)
				.set({ updatedAt: now })
				.where(eq(users.username, username)),
			auditInsertIfChanged(deps.db, entry(username)),
		]);
		expect(await auditRows(deps, username)).toEqual([]);
		await deps.db
			.insert(users)
			.values({ username, role: "viewer", createdAt: now, updatedAt: now });
		await deps.db.batch([
			deps.db
				.update(users)
				.set({ updatedAt: now + 1 })
				.where(eq(users.username, username)),
			auditInsertIfChanged(deps.db, entry(username)),
		]);
		expect(await auditRows(deps, username)).toHaveLength(1);
	});
});
