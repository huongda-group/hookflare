import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "../../src/core/db/schema";
import {
	beat,
	HEARTBEAT_KEY,
	HEARTBEAT_STALE_MS,
	heartbeatStale,
	readHeartbeat,
} from "../../src/core/heartbeat";
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

	it("treats a corrupt or non-object row as no heartbeat", async () => {
		const { db } = testDeps();
		for (const valueJson of ["{not json", "null", "[1,2]", "42"]) {
			await db
				.insert(settings)
				.values({ key: HEARTBEAT_KEY, valueJson, updatedAt: 1 })
				.onConflictDoUpdate({ target: settings.key, set: { valueJson } });
			expect(await readHeartbeat(db)).toBeNull();
		}
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

describe("heartbeatStale", () => {
	const now = 10 * HEARTBEAT_STALE_MS;

	it("judges by reconcile_at once the reconciler has beaten", () => {
		expect(
			heartbeatStale({ reconcile_at: now - HEARTBEAT_STALE_MS }, now),
		).toBe(false);
		expect(
			heartbeatStale({ reconcile_at: now - HEARTBEAT_STALE_MS - 1 }, now),
		).toBe(true);
	});

	it("is stale when reconcile never beat but first_at is too old", () => {
		expect(heartbeatStale({ first_at: 0, alerts_at: now }, now)).toBe(true);
		expect(heartbeatStale({ first_at: now - 1, alerts_at: 0 }, now)).toBe(
			false,
		);
	});

	it("falls back to the oldest key when first_at is missing (pre-first_at rows)", () => {
		expect(heartbeatStale({ alerts_at: now, archive_at: 0 }, now)).toBe(true);
		expect(heartbeatStale({ alerts_at: now - 1 }, now)).toBe(false);
	});

	it("is never stale for an empty map", () => {
		expect(heartbeatStale({}, now)).toBe(false);
	});
});
