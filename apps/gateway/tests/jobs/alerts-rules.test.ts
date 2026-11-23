import { DEFAULT_STORAGE_SETTINGS } from "@hookflare/shared";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { matchChannels } from "../../src/core/db/alerts";
import { backups, settings } from "../../src/core/db/schema";
import { STORAGE_SETTING } from "../../src/core/settings";
import {
	backupStale,
	consecutiveFailures,
	DEAD_CURSOR_KEY,
	d1Storage,
	newDead,
	stuckPending,
} from "../../src/jobs/alerts/rules";
import { RULES, resetAlerts } from "../helpers/alerts";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const deps = testDeps();
const NOW = 1_900_000_000_000;

beforeEach(() => resetAlerts(deps));

describe("consecutive_failures", () => {
	it("is active at the threshold for active destinations only", async () => {
		const a = await seedPipeline(deps, {
			destination: { consecutiveFailures: 5 },
		});
		const b = await seedPipeline(deps, {
			destination: { consecutiveFailures: 4 },
		});
		const c = await seedPipeline(deps, {
			destination: { consecutiveFailures: 9, status: "disabled" },
		});
		const ids = (await consecutiveFailures(deps.db, RULES)).map(
			(x) => x.resourceId,
		);
		expect(ids).toContain(a.destination.id);
		expect(ids).not.toContain(b.destination.id);
		expect(ids).not.toContain(c.destination.id);
	});
});

describe("stuck_pending", () => {
	it("is active for pending/queued deliveries older than stuck_after_s", async () => {
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p, {
			status: "queued",
			delivery: { createdAt: NOW - 301_000 },
		});
		const q = await seedPipeline(deps);
		await seedDelivery(deps, q, {
			status: "queued",
			delivery: { createdAt: NOW - 299_000 },
		});
		const active = await stuckPending(deps.db, RULES, NOW);
		const mine = active.find((x) => x.resourceId === p.destination.id);
		expect(mine?.details).toMatchObject({ stuck: 1 });
		expect(active.some((x) => x.resourceId === q.destination.id)).toBe(false);
	});
});

describe("new_dead (M5-13)", () => {
	it("initialises a missing cursor without alerting on history", async () => {
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p, {
			status: "dead",
			delivery: { completedAt: NOW - 3_600_000 },
		});
		const r = await newDead(deps.db, RULES, [], NOW);
		expect(r.active).toEqual([]);
		expect(r.cursor).toEqual({ from: null, to: NOW - 10_000 });
	});

	it("groups new dead deliveries by destination and keeps the 5 newest IDs", async () => {
		await deps.db.insert(settings).values({
			key: DEAD_CURSOR_KEY,
			valueJson: JSON.stringify({ at: NOW - 60_000 }),
			updatedAt: 1,
		});
		const p = await seedPipeline(deps);
		const ids: string[] = [];
		for (let i = 0; i < 6; i++) {
			const { deliveryId } = await seedDelivery(deps, p, {
				status: "dead",
				delivery: { completedAt: NOW - 50_000 + i },
			});
			ids.push(deliveryId);
		}
		const r = await newDead(deps.db, RULES, [], NOW);
		const mine = r.active.find((x) => x.resourceId === p.destination.id);
		expect(mine?.details).toMatchObject({ new_dead: 6 });
		expect(mine?.details.delivery_ids).toEqual(ids.slice(1).reverse());
		expect(r.cursor).toEqual({ from: NOW - 60_000, to: NOW - 10_000 });
	});

	it("stays active during the quiet period and lets go after it", async () => {
		await deps.db.insert(settings).values({
			key: DEAD_CURSOR_KEY,
			valueJson: JSON.stringify({ at: NOW - 10_000 }),
			updatedAt: 1,
		});
		const p = await seedPipeline(deps);
		const open = [
			{
				id: "alr_x",
				rule: "new_dead",
				resourceType: "destination",
				resourceId: p.destination.id,
				projectId: p.project.id,
				status: "open",
				openedAt: NOW - 600_000,
				lastNotifiedAt: null,
				resolvedAt: null,
				detailsJson: JSON.stringify({
					new_dead: 1,
					last_dead_at: NOW - 1_000_000,
				}),
			},
		] as const;
		const during = await newDead(
			deps.db,
			RULES,
			[...open] as never,
			NOW - 1_000_000 + 1_799_000,
		);
		expect(during.active.map((x) => x.resourceId)).toContain(p.destination.id);
		const after = await newDead(
			deps.db,
			RULES,
			[...open] as never,
			NOW - 1_000_000 + 1_801_000,
		);
		expect(after.active.map((x) => x.resourceId)).not.toContain(
			p.destination.id,
		);
	});
});

describe("new_dead scan bounds (Minor 6)", () => {
	it("stops at DEAD_MAX_DESTINATIONS and the cursor only passes what was read", async () => {
		const { DEAD_MAX_DESTINATIONS, scanDead } = await import(
			"../../src/jobs/alerts/rules"
		);
		const from = NOW + 50_000_000; // clear of rows other tests leave behind
		const until = from + 10_000;
		const ids: string[] = [];
		for (let i = 0; i <= DEAD_MAX_DESTINATIONS; i++) {
			const p = await seedPipeline(deps);
			const { deliveryId } = await seedDelivery(deps, p, {
				status: "dead",
				delivery: { completedAt: from + 1 + i },
			});
			ids.push(deliveryId);
		}
		const first = await scanDead(deps.db, from, until);
		expect(first.rows).toHaveLength(DEAD_MAX_DESTINATIONS);
		expect(first.to).toBe(from + DEAD_MAX_DESTINATIONS);
		const second = await scanDead(deps.db, first.to, until);
		expect(second.rows.map((r) => r.id)).toEqual([ids.at(-1)]);
		expect(second.to).toBe(until);
	});
});

describe("d1_storage hysteresis", () => {
	it("opens at d1_warn_pct and resolves only below d1_warn_pct − 5", async () => {
		const GB = 1024 ** 3;
		const at = (bytes: number, open: boolean) =>
			d1Storage(
				deps.db,
				RULES,
				open
					? ([
							{ rule: "d1_storage", resourceType: "system", resourceId: "d1" },
						] as never)
					: [],
				bytes,
			);
		expect(await at(8 * GB, false)).toHaveLength(1);
		expect(await at(7.9 * GB, false)).toHaveLength(0);
		expect(await at(7.6 * GB, true)).toHaveLength(1);
		expect(await at(7.4 * GB, true)).toHaveLength(0);
	});
});

describe("backup_stale", () => {
	const ENABLED = { ...DEFAULT_STORAGE_SETTINGS, backup_enabled: true };
	const stub = { db: deps.db, now: () => NOW };
	let n = 0;

	const fmt = (ms: number) =>
		new Date(ms).toISOString().slice(0, 19).replace("T", " ");

	beforeEach(async () => {
		await deps.db.delete(backups);
		await deps.db.delete(settings).where(eq(settings.key, STORAGE_SETTING.key));
	});

	async function seedBackup(o: {
		status: "running" | "verified" | "failed";
		finishedAt?: number | null;
		startedAt?: number;
	}) {
		const row = {
			id: `bak_stale_${n++}`,
			day: "2026-10-16",
			status: o.status,
			prefix: "test/backup/stale/",
			instanceId: "test-instance",
			trigger: "manual" as const,
			startedAt: o.startedAt ?? NOW - 40 * 3_600_000,
			finishedAt: o.finishedAt ?? null,
		};
		await deps.db.insert(backups).values(row);
		return row;
	}

	it("opens one alert when no backup was verified for 37 h", async () => {
		await seedBackup({
			status: "verified",
			startedAt: NOW - 38 * 3_600_000,
			finishedAt: NOW - 37 * 3_600_000,
		});
		const [a] = await backupStale(stub, ENABLED);
		expect(a).toMatchObject({
			rule: "backup_stale",
			resourceType: "system",
			resourceId: "backup",
			projectId: null,
			details: { last_verified_at: NOW - 37 * 3_600_000 },
		});
	});

	it("stays quiet when a backup was verified 1 h ago", async () => {
		await seedBackup({
			status: "verified",
			startedAt: NOW - 2 * 3_600_000,
			finishedAt: NOW - 3_600_000,
		});
		expect(await backupStale(stub, ENABLED)).toEqual([]);
	});

	it("stays quiet when backups are disabled", async () => {
		await seedBackup({
			status: "verified",
			startedAt: NOW - 38 * 3_600_000,
			finishedAt: NOW - 37 * 3_600_000,
		});
		expect(
			await backupStale(stub, { ...ENABLED, backup_enabled: false }),
		).toEqual([]);
	});

	it("gives a fresh deployment a grace period when no backup row exists", async () => {
		// The test D1 applied its migrations minutes ago, so against the wall
		// clock (not the file's 2030 NOW) the grace holds.
		const wallClock = { db: deps.db, now: () => Date.now() };
		expect(await backupStale(wallClock, ENABLED)).toEqual([]);
	});

	it("opens with a null timestamp for an old deployment with no backup row", async () => {
		const at = Date.now();
		const wallClock = { db: deps.db, now: () => at };
		await deps.db.run(
			sql`UPDATE d1_migrations SET applied_at = ${fmt(at - 40 * 3_600_000)}`,
		);
		try {
			const [a] = await backupStale(wallClock, ENABLED);
			expect(a).toMatchObject({
				rule: "backup_stale",
				resourceType: "system",
				resourceId: "backup",
				projectId: null,
				details: { last_verified_at: null },
			});
		} finally {
			await deps.db.run(sql`UPDATE d1_migrations SET applied_at = ${fmt(at)}`);
		}
	});
});

describe("matchChannels (spec §6.3 routing)", () => {
	const routes = [
		{ id: "all", rules: [], projectIds: [] },
		{ id: "dead-only", rules: ["new_dead"], projectIds: [] },
		{ id: "prj-a", rules: [], projectIds: ["prj_a"] },
	];
	it("matches empty lists as 'all'", () => {
		expect(matchChannels(routes, "new_dead", "prj_a")).toEqual([
			"all",
			"dead-only",
			"prj-a",
		]);
		expect(matchChannels(routes, "stuck_pending", "prj_b")).toEqual(["all"]);
	});
	it("sends system incidents only to unscoped channels", () => {
		expect(matchChannels(routes, "d1_storage", null)).toEqual(["all"]);
	});
});

describe("archive_stuck", () => {
	it("is active for failed batches and batches building for more than 48 h", async () => {
		const { archiveStuck } = await import("../../src/jobs/alerts/rules");
		const { isolateArchive, seedBatch } = await import("../helpers/archive");
		await isolateArchive(deps);
		expect(await archiveStuck(deps.db, NOW)).toEqual([]);
		await seedBatch(deps, {
			status: "building",
			createdAt: NOW - 47 * 3_600_000,
		});
		expect(await archiveStuck(deps.db, NOW)).toEqual([]);
		const failed = await seedBatch(deps, { status: "failed", createdAt: NOW });
		const [a] = await archiveStuck(deps.db, NOW);
		expect(a).toMatchObject({
			rule: "archive_stuck",
			resourceType: "system",
			resourceId: "archive",
			projectId: null,
		});
		expect(a.details.batch_ids).toEqual([failed.id]);
	});
	it("is active for a batch verified more than 48 h ago that never purged", async () => {
		const { archiveStuck } = await import("../../src/jobs/alerts/rules");
		const { isolateArchive, seedBatch } = await import("../helpers/archive");
		await isolateArchive(deps);
		await seedBatch(deps, {
			status: "verified",
			createdAt: NOW - 100 * 3_600_000,
			verifiedAt: NOW - 47 * 3_600_000,
		});
		expect(await archiveStuck(deps.db, NOW)).toEqual([]);
		const stale = await seedBatch(deps, {
			status: "verified",
			createdAt: NOW - 100 * 3_600_000,
			verifiedAt: NOW - 49 * 3_600_000,
		});
		const [a] = await archiveStuck(deps.db, NOW);
		expect(a.details.batch_ids).toEqual([stale.id]);
	});
	it("ignores a failed batch once a later batch of the same day succeeds", async () => {
		const { archiveStuck } = await import("../../src/jobs/alerts/rules");
		const { isolateArchive, seedBatch } = await import("../helpers/archive");
		await isolateArchive(deps);
		await seedBatch(deps, { status: "failed", createdAt: NOW - 3_600_000 });
		await seedBatch(deps, {
			kind: "audit",
			status: "purged",
			createdAt: NOW,
		});
		expect(await archiveStuck(deps.db, NOW)).toHaveLength(1);
		await seedBatch(deps, { status: "purged", createdAt: NOW });
		expect(await archiveStuck(deps.db, NOW)).toEqual([]);
	});
});
