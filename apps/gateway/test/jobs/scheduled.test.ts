import { eq } from "drizzle-orm";
import { describe, expect, it, type MockInstance, vi } from "vitest";
import { sessions, users } from "../../src/core/db/schema";
import {
	RECONCILE_CRON,
	ROLLUP_CRON,
	runScheduled,
} from "../../src/jobs/scheduled";
import { fakeArchive, testDeps, withFailingBatch } from "../helpers/deps";
import { faultyDeps } from "../helpers/faults";

const lines = (
	spy: MockInstance<typeof console.log> | MockInstance<typeof console.error>,
) => spy.mock.calls.map((c) => JSON.parse(c[0] as string).msg);

describe("runScheduled", () => {
	it("runs reconcile on the per-minute cron and logs one line", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await runScheduled(RECONCILE_CRON, testDeps());
		expect(lines(log)).toContain("reconcile.run");
	});

	it("logs reconcile.failed instead of throwing", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const deps = faultyDeps(testDeps(), { d1: [{ match: /deliveries/ }] });
		await expect(runScheduled(RECONCILE_CRON, deps)).resolves.toBeUndefined();
		expect(lines(err)).toContain("reconcile.failed");
	});

	it("runs the rollup on the 5-minute cron", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await runScheduled(ROLLUP_CRON, testDeps());
		expect(lines(log)).toContain("rollup.run");
		expect(lines(log)).not.toContain("reconcile.run");
	});

	it("logs rollup.failed instead of throwing", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const deps = faultyDeps(testDeps(), { d1: [{ match: /settings/ }] });
		await expect(runScheduled(ROLLUP_CRON, deps)).resolves.toBeUndefined();
		expect(lines(err)).toContain("rollup.failed");
	});

	it("runs the alerts job on the minute cron even when the reconciler fails", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const deps = testDeps({ db: withFailingBatch(testDeps().db) });
		await expect(runScheduled(RECONCILE_CRON, deps)).resolves.toBeUndefined();
		expect(
			[...lines(log), ...lines(err)].some(
				(m) => m === "alerts.run" || m === "alerts.failed",
			),
		).toBe(true);
		log.mockRestore();
		err.mockRestore();
	});

	it("purges expired sessions on the minute cron and keeps live ones", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const now = 1_800_000_000_000;
		const deps = testDeps({ now: () => now });
		const username = `u-${crypto.randomUUID().slice(0, 8)}`;
		await deps.db.insert(users).values({
			username,
			role: "admin",
			passwordHash: "pbkdf2-sha256$100000$c2FsdA==$aGFzaA==",
			passwordChangedAt: null,
			createdAt: now,
			updatedAt: now,
			disabledAt: null,
		});
		const expired = `expired-${crypto.randomUUID().slice(0, 8)}`;
		const live = `live-${crypto.randomUUID().slice(0, 8)}`;
		await deps.db.insert(sessions).values([
			{
				idHash: expired,
				username,
				createdAt: now - 1_000,
				lastSeenAt: now - 1_000,
				expiresAt: now - 1,
			},
			{
				idHash: live,
				username,
				createdAt: now,
				lastSeenAt: now,
				expiresAt: now + 1_000,
			},
		]);

		await runScheduled(RECONCILE_CRON, deps);

		const rows = await deps.db
			.select()
			.from(sessions)
			.where(eq(sessions.username, username));
		expect(rows.map((r) => r.idHash)).toEqual([live]);
		expect(lines(log)).toContain("sessions.purged");
		log.mockRestore();
	});

	it("logs sessions.purge_failed without stopping the alerts beat", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const deps = faultyDeps(testDeps(), { d1: [{ match: /sessions/ }] });

		await expect(runScheduled(RECONCILE_CRON, deps)).resolves.toBeUndefined();

		expect(
			[...lines(log), ...lines(err)].some(
				(m) => m === "alerts.run" || m === "alerts.failed",
			),
		).toBe(true);
		expect(lines(err)).toContain("sessions.purge_failed");
		log.mockRestore();
		err.mockRestore();
	});

	it("starts today's archive instance once on 0 3 * * *", async () => {
		const archive = fakeArchive();
		const deps = testDeps({ archive, now: () => Date.UTC(2027, 0, 5, 3) });
		await runScheduled("0 3 * * *", deps);
		await runScheduled("0 3 * * *", deps);
		expect(archive.created).toEqual(["archive-2027-01-05"]);
	});
});
