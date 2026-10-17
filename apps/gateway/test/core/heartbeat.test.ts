import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "../../src/core/db/schema";
import { beat, HEARTBEAT_KEY, readHeartbeat } from "../../src/core/heartbeat";
import type { Db } from "../../src/deps";
import { RECONCILE_CRON, runScheduled } from "../../src/jobs/scheduled";
import { testDeps } from "../helpers/deps";
import { faultyDeps } from "../helpers/faults";

beforeEach(async () => {
	await testDeps().db.delete(settings).where(eq(settings.key, HEARTBEAT_KEY));
});

describe("heartbeat", () => {
	it("merges keys across beats", async () => {
		const { db } = testDeps();
		await beat(db, "reconcile", 1000);
		await beat(db, "alerts", 2000);
		expect(await readHeartbeat(db)).toEqual({
			first_at: 1000,
			reconcile_at: 1000,
			alerts_at: 2000,
		});
	});

	it("returns null when no row exists", async () => {
		expect(await readHeartbeat(testDeps().db)).toBeNull();
	});

	it("throws when D1 is down, so the caller can log heartbeat.failed", async () => {
		const { db } = testDeps();
		const broken = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === "run") {
					return () => Promise.reject(new Error("D1_ERROR: simulated outage"));
				}
				return Reflect.get(target, prop, receiver);
			},
		}) as Db;
		await expect(beat(broken, "reconcile", 1)).rejects.toThrow(/simulated/);
	});

	it("runScheduled logs heartbeat.failed when the beat fails", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const base = testDeps();
			const deps = faultyDeps(base, { d1: [{ match: /json_set/ }] });
			await runScheduled(RECONCILE_CRON, deps);
			const lines = err.mock.calls.map((c) => JSON.parse(String(c[0])));
			expect(lines).toContainEqual(
				expect.objectContaining({ msg: "heartbeat.failed", job: "reconcile" }),
			);
		} finally {
			log.mockRestore();
			err.mockRestore();
		}
	});

	it("runScheduled beats alerts but not reconcile when reconcile throws", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const base = testDeps();
			// lease_until only appears in reconcile's expired-leases query.
			const deps = faultyDeps(base, { d1: [{ match: /lease_until/ }] });
			await runScheduled(RECONCILE_CRON, deps);
			const jobs = await readHeartbeat(base.db);
			expect(jobs?.alerts_at).toBeTypeOf("number");
			expect(jobs?.reconcile_at).toBeUndefined();
		} finally {
			log.mockRestore();
			err.mockRestore();
		}
	});
});
