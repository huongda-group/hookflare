import {
	DEFAULT_ALERT_RULES,
	DEFAULT_STORAGE_SETTINGS,
} from "@hookflare/shared";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sealChannelConfig } from "../../src/core/alert-channels";
import {
	type BatchItem,
	remindAlertStatements,
	resolveAlertStatements,
} from "../../src/core/db/alerts";
import {
	alertChannels,
	alertNotifications,
	alerts,
	backups,
	destinations,
	settings,
} from "../../src/core/db/schema";
import type { Logger } from "../../src/core/log";
import { createLogger } from "../../src/core/log";
import { clearSettingsCache, STORAGE_SETTING } from "../../src/core/settings";
import type { Deps } from "../../src/deps";
import {
	CLAIM_STALE_MS,
	MAX_CHANGES_PER_RUN,
	runAlerts,
	SEND_BUDGET_MS,
	SEND_CONCURRENCY,
	sendPendingNotifications,
} from "../../src/jobs/alerts/job";
import {
	DEAD_CURSOR_KEY,
	FAILURES_QUIET_MS,
} from "../../src/jobs/alerts/rules";
import { resetAlerts } from "../helpers/alerts";
import { testDeps } from "../helpers/deps";
import { testEnv } from "../helpers/env";
import { faultyDeps } from "../helpers/faults";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const logger = createLogger({ LOG_LEVEL: "error" });
/** One INSERT per row: a single multi-row insert passes D1's bound-variable limit. */
const insertMany = (deps: Deps, rows: (typeof alerts.$inferInsert)[]) =>
	deps.db.batch(
		rows.map((r) => deps.db.insert(alerts).values(r)) as unknown as [
			BatchItem,
			...BatchItem[],
		],
	);
function spyLogger() {
	const errors: string[] = [];
	const warns: [string, unknown][] = [];
	const spy: Logger = {
		debug: () => {},
		info: () => {},
		warn: (msg, fields) => {
			warns.push([msg, fields]);
		},
		error: (msg) => {
			errors.push(msg);
		},
	};
	return { logger: spy, errors, warns };
}
const DISCORD = {
	type: "discord",
	url: "https://discord.com/api/webhooks/1/abc",
} as const;

async function addChannel(
	deps: Deps,
	id: string,
	o: { rules?: string[]; projectIds?: string[] } = {},
) {
	const sealed = await sealChannelConfig(deps.env, id, DISCORD);
	await deps.db.insert(alertChannels).values({
		id,
		name: id,
		type: "discord",
		...sealed,
		enabled: true,
		rulesJson: JSON.stringify(o.rules ?? []),
		projectIdsJson: JSON.stringify(o.projectIds ?? []),
		createdAt: 1,
		updatedAt: 1,
	});
}

function clockDeps(start: number, fetchImpl?: typeof fetch) {
	let now = start;
	const deps = testDeps({
		now: () => now,
		fetch:
			fetchImpl ??
			(vi.fn(
				async () => new Response(null, { status: 204 }),
			) as unknown as typeof fetch),
	});
	return {
		deps,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const T = 1_900_000_000_000;

async function incidents(deps: Deps, destinationId: string) {
	return deps.db
		.select()
		.from(alerts)
		.where(eq(alerts.resourceId, destinationId));
}
async function notes(deps: Deps, alertId: string) {
	return deps.db
		.select()
		.from(alertNotifications)
		.where(eq(alertNotifications.alertId, alertId))
		.orderBy(alertNotifications.id);
}
const failing = (deps: Deps, id: string, n: number) =>
	deps.db
		.update(destinations)
		.set({ consecutiveFailures: n })
		.where(eq(destinations.id, id));

describe("runAlerts", () => {
	beforeEach(async () => {
		clearSettingsCache();
		const deps = testDeps();
		await resetAlerts(deps);
		await deps.db.delete(settings).where(eq(settings.key, "alert_rules"));
		// Keep backup_stale quiet unless a test says otherwise: the file's
		// fake clock (T) is years past the test D1's migration timestamps, so
		// the fresh-deploy grace never holds here without a recent backup.
		await deps.db.delete(backups);
		await deps.db.delete(settings).where(eq(settings.key, STORAGE_SETTING.key));
		await deps.db.insert(backups).values({
			id: "bak_fresh",
			day: "2030-03-16",
			status: "verified",
			prefix: "test/backup/fresh/",
			instanceId: "test-instance",
			trigger: "manual",
			startedAt: T - 2 * 3_600_000,
			finishedAt: T - 3_600_000,
		});
	});

	it("opens once, notifies every matching channel, and resolves (spec §6.3)", async () => {
		const { deps, advance } = clockDeps(T);
		await addChannel(deps, "ach_a");
		await addChannel(deps, "ach_b", { rules: ["new_dead"] });
		const p = await seedPipeline(deps, {
			destination: { consecutiveFailures: 5 },
		});

		await runAlerts(deps, logger);
		await runAlerts(deps, logger);
		const [open] = await incidents(deps, p.destination.id);
		expect(await incidents(deps, p.destination.id)).toHaveLength(1);
		expect(open.status).toBe("open");
		const opened = await notes(deps, open.id);
		expect(opened.map((n) => [n.channelId, n.kind, n.status])).toEqual([
			["ach_a", "opened", "sent"],
		]);
		expect(deps.fetch).toHaveBeenCalledTimes(1);

		await failing(deps, p.destination.id, 0);
		advance(60_000);
		await runAlerts(deps, logger);
		advance(FAILURES_QUIET_MS);
		await runAlerts(deps, logger);
		const [resolved] = await incidents(deps, p.destination.id);
		expect(resolved.status).toBe("resolved");
		expect((await notes(deps, open.id)).map((n) => n.kind)).toEqual([
			"opened",
			"resolved",
		]);
	});

	it("keeps a flapping consecutive_failures incident open inside the quiet period", async () => {
		const { deps, advance } = clockDeps(T);
		await addChannel(deps, "ach_a");
		const p = await seedPipeline(deps, {
			destination: { consecutiveFailures: 5 },
		});
		const kinds = async (id: string) =>
			(await notes(deps, id)).map((n) => n.kind);
		await runAlerts(deps, logger);
		const [open] = await incidents(deps, p.destination.id);

		// One success, then a new streak, a few times: one incident, no resolve.
		for (let i = 0; i < 3; i++) {
			await failing(deps, p.destination.id, 0);
			advance(60_000);
			expect((await runAlerts(deps, logger)).resolved).toBe(0);
			await failing(deps, p.destination.id, 5);
			advance(60_000);
			expect((await runAlerts(deps, logger)).opened).toBe(0);
		}
		expect(await incidents(deps, p.destination.id)).toMatchObject([
			{ id: open.id, status: "open" },
		]);
		expect(await kinds(open.id)).toEqual(["opened"]);
		expect(deps.fetch).toHaveBeenCalledTimes(1);

		// Clear, but a run just short of the quiet period keeps it open.
		await failing(deps, p.destination.id, 0);
		advance(60_000);
		await runAlerts(deps, logger);
		advance(FAILURES_QUIET_MS - 1);
		expect((await runAlerts(deps, logger)).resolved).toBe(0);
		expect((await incidents(deps, p.destination.id))[0].status).toBe("open");

		// Clear for the whole quiet period: resolved, notified once.
		advance(1);
		expect((await runAlerts(deps, logger)).resolved).toBe(1);
		const [resolved] = await incidents(deps, p.destination.id);
		expect(resolved).toMatchObject({ id: open.id, status: "resolved" });
		expect(await kinds(open.id)).toEqual(["opened", "resolved"]);
		expect(deps.fetch).toHaveBeenCalledTimes(2);
	});

	it("resolves stuck_pending as soon as it clears (no quiet period)", async () => {
		const { deps, advance } = clockDeps(T);
		const p = await seedPipeline(deps);
		const { deliveryId } = await seedDelivery(deps, p, {
			status: "pending",
			delivery: { createdAt: T - 3_600_000 },
		});
		await runAlerts(deps, logger);
		const stuck = async () =>
			(await incidents(deps, p.destination.id)).filter(
				(a) => a.rule === "stuck_pending",
			);
		expect(await stuck()).toMatchObject([{ status: "open" }]);
		await deps.db.run(
			sql`UPDATE deliveries SET status = 'delivered' WHERE id = ${deliveryId}`,
		);
		advance(60_000);
		await runAlerts(deps, logger);
		expect(await stuck()).toMatchObject([{ status: "resolved" }]);
	});

	it("opens one incident when two runs overlap (M5-11)", async () => {
		const { deps } = clockDeps(T);
		await addChannel(deps, "ach_a");
		const p = await seedPipeline(deps, {
			destination: { consecutiveFailures: 5 },
		});
		await Promise.all([runAlerts(deps, logger), runAlerts(deps, logger)]);
		const rows = await incidents(deps, p.destination.id);
		expect(rows).toHaveLength(1);
		expect(await notes(deps, rows[0].id)).toHaveLength(1);
	});

	it("overlapping remind runs insert a single reminder", async () => {
		const { deps } = clockDeps(T);
		await addChannel(deps, "ach_a");
		const p = await seedPipeline(deps, {
			destination: { consecutiveFailures: 5 },
		});
		await runAlerts(deps, logger);
		const [alert] = await incidents(deps, p.destination.id);
		// Two runs read the same snapshot at the same timestamp.
		const later = T + 3_601_000;
		const first = remindAlertStatements(deps.db, alert, later, ["ach_a"]);
		const second = remindAlertStatements(deps.db, alert, later, ["ach_a"]);
		await deps.db.batch(first as [BatchItem, ...BatchItem[]]);
		await deps.db.batch(second as [BatchItem, ...BatchItem[]]);
		expect((await notes(deps, alert.id)).map((n) => n.kind)).toEqual([
			"opened",
			"reminder",
		]);
	});

	it("overlapping resolve runs insert a single resolved notification", async () => {
		const { deps } = clockDeps(T);
		await addChannel(deps, "ach_a");
		const p = await seedPipeline(deps, {
			destination: { consecutiveFailures: 5 },
		});
		await runAlerts(deps, logger);
		await failing(deps, p.destination.id, 0);
		const [alert] = await incidents(deps, p.destination.id);
		// Two runs read the same open snapshot at the same timestamp.
		const later = T + 60_000;
		const first = resolveAlertStatements(deps.db, alert, later, ["ach_a"]);
		const second = resolveAlertStatements(deps.db, alert, later, ["ach_a"]);
		await deps.db.batch(first as [BatchItem, ...BatchItem[]]);
		await deps.db.batch(second as [BatchItem, ...BatchItem[]]);
		const [resolved] = await incidents(deps, p.destination.id);
		expect(resolved.status).toBe("resolved");
		expect((await notes(deps, alert.id)).map((n) => n.kind)).toEqual([
			"opened",
			"resolved",
		]);
	});

	it("reminds after reminder_s and never when reminder_s = 0", async () => {
		const { deps, advance } = clockDeps(T);
		await addChannel(deps, "ach_a");
		const p = await seedPipeline(deps, {
			destination: { consecutiveFailures: 5 },
		});
		await runAlerts(deps, logger);
		advance(3_599_000);
		await runAlerts(deps, logger);
		const [a] = await incidents(deps, p.destination.id);
		expect((await notes(deps, a.id)).map((n) => n.kind)).toEqual(["opened"]);
		advance(2_000);
		await runAlerts(deps, logger);
		expect((await notes(deps, a.id)).map((n) => n.kind)).toEqual([
			"opened",
			"reminder",
		]);

		await deps.db.insert(settings).values({
			key: "alert_rules",
			valueJson: JSON.stringify({ ...DEFAULT_ALERT_RULES, reminder_s: 0 }),
			updatedAt: 1,
		});
		clearSettingsCache();
		advance(10 * 3_600_000);
		await runAlerts(deps, logger);
		expect((await notes(deps, a.id)).map((n) => n.kind)).toEqual([
			"opened",
			"reminder",
		]);
	});

	it("resolves when the destination is disabled (Review Focus 1)", async () => {
		const { deps, advance } = clockDeps(T);
		const p = await seedPipeline(deps, {
			destination: { consecutiveFailures: 5 },
		});
		await runAlerts(deps, logger);
		await deps.db
			.update(destinations)
			.set({ status: "disabled" })
			.where(eq(destinations.id, p.destination.id));
		advance(60_000);
		await runAlerts(deps, logger);
		advance(FAILURES_QUIET_MS);
		await runAlerts(deps, logger);
		expect((await incidents(deps, p.destination.id))[0].status).toBe(
			"resolved",
		);
	});

	it("retries a failing channel up to 3 tries without resending to the others (M5-14)", async () => {
		const fetchImpl = vi.fn(
			async (url: string) =>
				new Response(null, { status: String(url).includes("/2/") ? 500 : 204 }),
		) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
		const { deps, advance } = clockDeps(T, fetchImpl);
		await addChannel(deps, "ach_ok");
		const sealed = await sealChannelConfig(deps.env, "ach_bad", {
			type: "discord",
			url: "https://discord.com/api/webhooks/2/bad",
		});
		await deps.db.insert(alertChannels).values({
			id: "ach_bad",
			name: "bad",
			type: "discord",
			...sealed,
			enabled: true,
			rulesJson: "[]",
			projectIdsJson: "[]",
			createdAt: 1,
			updatedAt: 1,
		});
		const p = await seedPipeline(deps, {
			destination: { consecutiveFailures: 5 },
		});
		for (let i = 0; i < 4; i++) {
			await runAlerts(deps, logger);
			advance(60_000);
		}
		const [a] = await incidents(deps, p.destination.id);
		const byChannel = Object.fromEntries(
			(await notes(deps, a.id)).map((n) => [n.channelId, n]),
		);
		expect(byChannel.ach_ok).toMatchObject({ status: "sent", tries: 1 });
		expect(byChannel.ach_bad).toMatchObject({
			status: "failed",
			tries: 3,
			lastError: "HTTP 500",
		});
		const okCalls = fetchImpl.mock.calls.filter(([u]) =>
			String(u).includes("/1/"),
		);
		expect(okCalls).toHaveLength(1);
	});

	it("reclaims a row stuck in sending after 60 s", async () => {
		const { deps, advance } = clockDeps(T);
		await addChannel(deps, "ach_a");
		const p = await seedPipeline(deps);
		await deps.db.insert(alerts).values({
			id: "alr_stuck",
			rule: "new_dead",
			resourceType: "destination",
			resourceId: p.destination.id,
			projectId: p.project.id,
			status: "open",
			openedAt: T,
			detailsJson: "{}",
		});
		await deps.db.insert(alertNotifications).values({
			id: "ant_stuck",
			alertId: "alr_stuck",
			channelId: "ach_a",
			kind: "opened",
			status: "sending",
			tries: 1,
			createdAt: T,
			claimedAt: T,
		});
		advance(30_000);
		await runAlerts(deps, logger);
		expect((await notes(deps, "alr_stuck"))[0].status).toBe("sending");
		advance(31_000);
		await runAlerts(deps, logger);
		expect((await notes(deps, "alr_stuck"))[0]).toMatchObject({
			status: "sent",
			tries: 2,
		});
	});

	it("advances the dead cursor and detects dead deliveries from the budget and the DLQ", async () => {
		const { deps, advance } = clockDeps(T);
		await runAlerts(deps, logger); // initialises the cursor
		const p = await seedPipeline(deps);
		advance(30_000);
		const { seedDelivery } = await import("../helpers/seed");
		await seedDelivery(deps, p, {
			status: "dead",
			delivery: {
				completedAt: T + 1_000,
				lastError: "dlq: infra retries exhausted",
			},
		});
		await seedDelivery(deps, p, {
			status: "dead",
			delivery: { completedAt: T + 2_000, lastError: "HTTP 500" },
		});
		await runAlerts(deps, logger);
		const [a] = await incidents(deps, p.destination.id);
		expect(a.rule).toBe("new_dead");
		expect(JSON.parse(a.detailsJson)).toMatchObject({ new_dead: 2 });
		const [cursor] = await deps.db
			.select()
			.from(settings)
			.where(eq(settings.key, "alerts.dead_cursor"));
		expect(JSON.parse(cursor.valueJson)).toEqual({ at: T + 30_000 - 10_000 });
		advance(1_801_000);
		await runAlerts(deps, logger);
		expect((await incidents(deps, p.destination.id))[0].status).toBe(
			"resolved",
		);
	});

	it("counts every fresh new_dead batch, even equal-sized ones (I4)", async () => {
		const { deps, advance } = clockDeps(T);
		await runAlerts(deps, logger); // initialises the cursor at T − 10 s
		const p = await seedPipeline(deps);
		const a = await seedDelivery(deps, p, {
			status: "dead",
			delivery: { completedAt: T - 5_000 },
		});
		advance(60_000);
		await runAlerts(deps, logger);
		const b = await seedDelivery(deps, p, {
			status: "dead",
			delivery: { completedAt: T + 55_000 },
		});
		advance(60_000);
		await runAlerts(deps, logger);
		const [inc] = await incidents(deps, p.destination.id);
		expect(JSON.parse(inc.detailsJson)).toEqual({
			new_dead: 2,
			delivery_ids: [b.deliveryId, a.deliveryId],
			last_dead_at: T + 55_000,
		});
		advance(60_000);
		await runAlerts(deps, logger); // quiet run
		const [same] = await incidents(deps, p.destination.id);
		expect(same.status).toBe("open");
		expect(same.detailsJson).toBe(inc.detailsJson);
	});

	it("never moves the dead cursor backwards (overlapping runs)", async () => {
		const { deps } = clockDeps(T);
		await deps.db.insert(settings).values({
			key: DEAD_CURSOR_KEY,
			valueJson: JSON.stringify({ at: T + 100_000 }),
			updatedAt: 1,
		});
		await runAlerts(deps, logger);
		const [cursor] = await deps.db
			.select()
			.from(settings)
			.where(eq(settings.key, DEAD_CURSOR_KEY));
		expect(JSON.parse(cursor.valueJson)).toEqual({ at: T + 100_000 });
	});

	it(`opens at most ${MAX_CHANGES_PER_RUN} incidents per run and the rest next run`, async () => {
		const { deps, advance } = clockDeps(T);
		const ids: string[] = [];
		for (let i = 0; i < MAX_CHANGES_PER_RUN + 3; i++) {
			const p = await seedPipeline(deps, {
				destination: { consecutiveFailures: 5 },
			});
			ids.push(p.destination.id);
		}
		const first = await runAlerts(deps, logger);
		expect(first.opened).toBe(MAX_CHANGES_PER_RUN);
		advance(60_000);
		const second = await runAlerts(deps, logger);
		// Other active rules in the shared database may take some of the first run's slots.
		expect(second.opened).toBeGreaterThanOrEqual(3);
		for (const id of ids) expect(await incidents(deps, id)).toHaveLength(1);
	});

	it("resolves backup_stale when backups are switched off, queueing a resolved notification (M6-16)", async () => {
		const { deps, advance } = clockDeps(T);
		await addChannel(deps, "ach_a");
		await deps.db.delete(backups);
		await deps.db.delete(settings).where(eq(settings.key, STORAGE_SETTING.key));
		await deps.db.insert(backups).values({
			id: "bak_job_stale",
			day: "2026-10-15",
			status: "verified",
			prefix: "test/backup/job/",
			instanceId: "test-instance",
			trigger: "manual",
			startedAt: T - 38 * 3_600_000,
			finishedAt: T - 37 * 3_600_000,
		});

		await runAlerts(deps, logger);
		const [open] = await deps.db
			.select()
			.from(alerts)
			.where(eq(alerts.resourceId, "backup"));
		expect(open).toMatchObject({ rule: "backup_stale", status: "open" });

		await deps.db.insert(settings).values({
			key: STORAGE_SETTING.key,
			valueJson: JSON.stringify({
				...DEFAULT_STORAGE_SETTINGS,
				backup_enabled: false,
			}),
			updatedAt: T,
		});
		advance(60_000);
		await runAlerts(deps, logger);
		const [resolved] = await deps.db
			.select()
			.from(alerts)
			.where(eq(alerts.resourceId, "backup"));
		expect(resolved.status).toBe("resolved");
		expect((await notes(deps, open.id)).map((n) => n.kind)).toEqual([
			"opened",
			"resolved",
		]);

		await deps.db.delete(backups);
		await deps.db.delete(settings).where(eq(settings.key, STORAGE_SETTING.key));
	});

	it(`resolves at most ${MAX_CHANGES_PER_RUN} incidents per run and the rest next run`, async () => {
		const { deps, advance } = clockDeps(T);
		const n = MAX_CHANGES_PER_RUN + 2;
		await insertMany(
			deps,
			Array.from({ length: n }, (_, i) => ({
				id: `alr_gone_${String(i).padStart(3, "0")}`,
				rule: "stuck_pending",
				resourceType: "destination" as const,
				resourceId: `dst_gone_${i}`,
				projectId: null,
				status: "open" as const,
				openedAt: T - 60_000,
				detailsJson: "{}",
			})),
		);
		const openCount = async () =>
			(
				await deps.db.select().from(alerts).where(eq(alerts.status, "open"))
			).filter((a) => a.id.startsWith("alr_gone_")).length;
		expect((await runAlerts(deps, logger)).resolved).toBe(MAX_CHANGES_PER_RUN);
		expect(await openCount()).toBe(2);
		advance(60_000);
		expect((await runAlerts(deps, logger)).resolved).toBe(2);
		expect(await openCount()).toBe(0);
	});

	it(`reminds at most ${MAX_CHANGES_PER_RUN} incidents per run, including never-notified ones`, async () => {
		const { deps, advance } = clockDeps(T);
		await addChannel(deps, "ach_a");
		const n = MAX_CHANGES_PER_RUN + 2;
		// Open new_dead incidents stay active through the quiet period (carry-over).
		await insertMany(
			deps,
			Array.from({ length: n }, (_, i) => ({
				id: `alr_rem_${String(i).padStart(3, "0")}`,
				rule: "new_dead",
				resourceType: "destination" as const,
				resourceId: `dst_rem_${i}`,
				projectId: null,
				status: "open" as const,
				openedAt: T - 2 * 3_600_000,
				// The first one was opened with no channel to notify.
				lastNotifiedAt: i === 0 ? null : T - 2 * 3_600_000,
				detailsJson: JSON.stringify({ last_dead_at: T - 60_000 }),
			})),
		);
		const first = await runAlerts(deps, logger);
		expect(first.reminded).toBe(MAX_CHANGES_PER_RUN);
		const [never] = await deps.db
			.select()
			.from(alerts)
			.where(eq(alerts.id, "alr_rem_000"));
		expect(never.lastNotifiedAt).toBe(T);
		expect((await notes(deps, "alr_rem_000")).map((r) => r.kind)).toEqual([
			"reminder",
		]);
		advance(60_000);
		expect((await runAlerts(deps, logger)).reminded).toBe(2);
		const reminded = await deps.db
			.select()
			.from(alertNotifications)
			.where(eq(alertNotifications.kind, "reminder"));
		expect(reminded).toHaveLength(n);
	});

	it("adds fresh dead deliveries to an incident whose stored details lack counters", async () => {
		const { deps } = clockDeps(T);
		const p = await seedPipeline(deps);
		await deps.db.insert(settings).values({
			key: DEAD_CURSOR_KEY,
			valueJson: JSON.stringify({ at: T - 60_000 }),
			updatedAt: 1,
		});
		await deps.db.insert(alerts).values({
			id: "alr_bare",
			rule: "new_dead",
			resourceType: "destination",
			resourceId: p.destination.id,
			projectId: p.project.id,
			status: "open",
			openedAt: T - 120_000,
			lastNotifiedAt: T - 120_000,
			detailsJson: "{}",
		});
		const { deliveryId } = await seedDelivery(deps, p, {
			status: "dead",
			delivery: { completedAt: T - 30_000 },
		});
		await runAlerts(deps, logger);
		const [inc] = await incidents(deps, p.destination.id);
		expect(inc.id).toBe("alr_bare");
		expect(JSON.parse(inc.detailsJson)).toEqual({
			new_dead: 1,
			delivery_ids: [deliveryId],
			last_dead_at: T - 30_000,
		});
	});
});

async function seedNotifications(
	deps: Deps,
	destinationId: string,
	projectId: string,
	n: number,
) {
	await deps.db.insert(alerts).values({
		id: "alr_out",
		rule: "new_dead",
		resourceType: "destination",
		resourceId: destinationId,
		projectId,
		status: "open",
		openedAt: T,
		detailsJson: "{}",
	});
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		const id = `ant_${String(i).padStart(3, "0")}`;
		ids.push(id);
		await deps.db.insert(alertNotifications).values({
			id,
			alertId: "alr_out",
			channelId: "ach_a",
			kind: "opened",
			status: "pending",
			tries: 0,
			createdAt: T + i,
		});
	}
	return ids;
}

describe("sendPendingNotifications (outbox)", () => {
	beforeEach(async () => {
		clearSettingsCache();
		await resetAlerts(testDeps());
	});

	it("overlapping runs with slow sends deliver each notification exactly once (I3)", async () => {
		let now = T;
		let overlap: Promise<unknown> | null = null;
		let deps!: Deps;
		const fetchImpl = vi.fn(async () => {
			now += 2_000; // each send takes 2 s
			// The next minute's cron fires while this run is still sending.
			if (!overlap && now >= T + 61_000)
				overlap = sendPendingNotifications(deps, logger);
			await new Promise((r) => setTimeout(r, 1));
			return new Response(null, { status: 204 });
		});
		deps = testDeps({
			now: () => now,
			fetch: fetchImpl as unknown as typeof fetch,
		});
		await addChannel(deps, "ach_a");
		const p = await seedPipeline(deps);
		const ids = await seedNotifications(
			deps,
			p.destination.id,
			p.project.id,
			45,
		);
		await sendPendingNotifications(deps, logger);
		if (overlap) await overlap;
		for (let i = 0; i < 5; i++) {
			now += 60_000;
			await sendPendingNotifications(deps, logger);
		}
		const rows = await notes(deps, "alr_out");
		expect(rows.map((r) => r.status)).toEqual(ids.map(() => "sent"));
		expect(rows.every((r) => r.tries === 1)).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(45);
	});

	it("a stale run cannot overwrite a newer run's settle (I3)", async () => {
		let now = T;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let calls = 0;
		const fetchImpl = vi.fn(async () => {
			calls++;
			if (calls === 1) {
				await gate;
				return new Response(null, { status: 500 });
			}
			return new Response(null, { status: 204 });
		});
		const deps = testDeps({
			now: () => now,
			fetch: fetchImpl as unknown as typeof fetch,
		});
		await addChannel(deps, "ach_a");
		const p = await seedPipeline(deps);
		await seedNotifications(deps, p.destination.id, p.project.id, 1);
		const stale = sendPendingNotifications(deps, logger);
		await vi.waitFor(() => expect(calls).toBe(1));
		now += 5 * 60_000;
		await sendPendingNotifications(deps, logger);
		release();
		await stale;
		const [row] = await notes(deps, "alr_out");
		expect(row).toMatchObject({ status: "sent", tries: 2 });
	});

	it("settles notifications for a disabled channel as failed without sending", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
		const deps = testDeps({
			now: () => T,
			fetch: fetchImpl as unknown as typeof fetch,
		});
		await addChannel(deps, "ach_a");
		await deps.db
			.update(alertChannels)
			.set({ enabled: false })
			.where(eq(alertChannels.id, "ach_a"));
		const p = await seedPipeline(deps);
		await seedNotifications(deps, p.destination.id, p.project.id, 1);
		const r = await sendPendingNotifications(deps, logger);
		expect(r).toEqual({ sent: 0, failed: 1 });
		expect(fetchImpl).not.toHaveBeenCalled();
		const [row] = await notes(deps, "alr_out");
		expect(row).toMatchObject({
			status: "failed",
			lastError: "channel_disabled",
		});
	});

	it("a row that throws is settled as a failed try and the loop continues", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
		const deps = testDeps({
			now: () => T,
			fetch: fetchImpl as unknown as typeof fetch,
		});
		await addChannel(deps, "ach_a");
		const p = await seedPipeline(deps);
		await seedNotifications(deps, p.destination.id, p.project.id, 2);
		await deps.db.insert(alerts).values({
			id: "alr_corrupt",
			rule: "new_dead",
			resourceType: "destination",
			resourceId: "dst_corrupt",
			projectId: p.project.id,
			status: "resolved",
			openedAt: T,
			detailsJson: "{not json",
		});
		await deps.db.insert(alertNotifications).values({
			id: "ant_corrupt",
			alertId: "alr_corrupt",
			channelId: "ach_a",
			kind: "opened",
			status: "pending",
			tries: 0,
			createdAt: T - 1,
		});
		const r = await sendPendingNotifications(deps, logger);
		expect(r.sent).toBe(2);
		const [bad] = await notes(deps, "alr_corrupt");
		expect(bad).toMatchObject({ status: "pending", tries: 1 });
		expect(bad.lastError).toBeTruthy();
	});

	it("hands unsent claims back as untried once the send budget is spent", async () => {
		let now = T;
		const fetchImpl = vi.fn(async () => {
			now += 4_000; // ten parallel sends push the run past SEND_BUDGET_MS
			return new Response(null, { status: 204 });
		});
		const deps = testDeps({
			now: () => now,
			fetch: fetchImpl as unknown as typeof fetch,
		});
		await addChannel(deps, "ach_a");
		const p = await seedPipeline(deps);
		await seedNotifications(deps, p.destination.id, p.project.id, 12);
		const r = await sendPendingNotifications(deps, logger);
		expect(r).toEqual({ sent: 10, failed: 0 });
		expect(fetchImpl).toHaveBeenCalledTimes(SEND_CONCURRENCY);
		const rows = await notes(deps, "alr_out");
		expect(rows.slice(10)).toMatchObject([
			{ status: "pending", tries: 0, claimedAt: null },
			{ status: "pending", tries: 0, claimedAt: null },
		]);
	});

	it("starts no send once 15 s of the minute cron have passed", async () => {
		expect(SEND_BUDGET_MS).toBe(15_000);
		const run = async (perSend: number) => {
			let now = T;
			const fetchImpl = vi.fn(async () => {
				now += perSend;
				return new Response(null, { status: 204 });
			});
			const deps = testDeps({
				now: () => now,
				fetch: fetchImpl as unknown as typeof fetch,
			});
			await resetAlerts(deps);
			await addChannel(deps, "ach_a");
			const p = await seedPipeline(deps);
			await seedNotifications(deps, p.destination.id, p.project.id, 12);
			return sendPendingNotifications(deps, logger);
		};
		// The first ten sends take 14 s: the last two still start.
		expect(await run(1_400)).toEqual({ sent: 12, failed: 0 });
		// They take 15 s: the budget is spent and the last two wait.
		expect(await run(1_500)).toEqual({ sent: 10, failed: 0 });
	});

	it("leaves the claim for takeover when handing back unsent rows fails", async () => {
		let now = T;
		const fetchImpl = vi.fn(async () => {
			now += 4_000;
			return new Response(null, { status: 204 });
		});
		const base = testDeps({
			now: () => now,
			fetch: fetchImpl as unknown as typeof fetch,
		});
		await addChannel(base, "ach_a");
		const p = await seedPipeline(base);
		await seedNotifications(base, p.destination.id, p.project.id, 12);
		const spy = spyLogger();
		const deps = faultyDeps(base, { d1: [{ match: /tries - 1/ }] });
		await sendPendingNotifications(deps, spy.logger);
		expect(spy.errors).toContain("alerts.release_failed");
		const stuck = (await notes(base, "alr_out")).slice(10);
		expect(stuck).toMatchObject([
			{ status: "sending", tries: 1 },
			{ status: "sending", tries: 1 },
		]);
		// A run past CLAIM_STALE_MS takes the claims over and sends them.
		now += CLAIM_STALE_MS + 1;
		expect(await sendPendingNotifications(base, logger)).toEqual({
			sent: 2,
			failed: 0,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(12);
	});

	it("keeps the claim when settling a sent row fails, so a later run takes it over", async () => {
		let now = T;
		const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
		const base = testDeps({
			now: () => now,
			fetch: fetchImpl as unknown as typeof fetch,
		});
		await addChannel(base, "ach_a");
		const p = await seedPipeline(base);
		await seedNotifications(base, p.destination.id, p.project.id, 1);
		const spy = spyLogger();
		const deps = faultyDeps(base, { d1: [{ match: /"sent_at" = \?/ }] });
		await sendPendingNotifications(deps, spy.logger);
		expect(spy.errors).toContain("alerts.settle_failed");
		expect((await notes(base, "alr_out"))[0]).toMatchObject({
			status: "sending",
			tries: 1,
		});
		now += CLAIM_STALE_MS + 1;
		await sendPendingNotifications(base, logger);
		expect((await notes(base, "alr_out"))[0]).toMatchObject({
			status: "sent",
			tries: 2,
		});
	});

	it("retries a channel whose stored config cannot be opened, without sending", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
		const deps = testDeps({
			now: () => T,
			fetch: fetchImpl as unknown as typeof fetch,
		});
		await addChannel(deps, "ach_a");
		await deps.db
			.update(alertChannels)
			.set({ configEnc: "v1.garbage" })
			.where(eq(alertChannels.id, "ach_a"));
		const p = await seedPipeline(deps);
		await seedNotifications(deps, p.destination.id, p.project.id, 1);
		expect(await sendPendingNotifications(deps, logger)).toEqual({
			sent: 0,
			failed: 0,
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect((await notes(deps, "alr_out"))[0]).toMatchObject({
			status: "pending",
			tries: 1,
			lastError: "config_unreadable",
		});
	});

	it("drops a claimed notification whose channel was deleted mid-run without sending it", async () => {
		let deps!: Deps;
		const fetchImpl = vi.fn(async () => {
			// An operator deletes channel b (and its outbox rows) while the first chunk sends.
			await deps.db
				.delete(alertNotifications)
				.where(eq(alertNotifications.channelId, "ach_b"));
			await deps.db.delete(alertChannels).where(eq(alertChannels.id, "ach_b"));
			return new Response(null, { status: 204 });
		});
		deps = testDeps({
			now: () => T,
			fetch: fetchImpl as unknown as typeof fetch,
		});
		await addChannel(deps, "ach_a");
		await addChannel(deps, "ach_b");
		const p = await seedPipeline(deps);
		await seedNotifications(deps, p.destination.id, p.project.id, 10);
		await deps.db.insert(alertNotifications).values({
			id: "ant_b",
			alertId: "alr_out",
			channelId: "ach_b",
			kind: "opened",
			status: "pending",
			tries: 0,
			createdAt: T + 100,
		});
		const spy = spyLogger();
		expect(await sendPendingNotifications(deps, spy.logger)).toEqual({
			sent: 10,
			failed: 0,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(10);
		expect(spy.warns).toContainEqual([
			"alerts.send_failed",
			expect.objectContaining({ error: "channel_or_alert_missing" }),
		]);
		expect(
			(await notes(deps, "alr_out")).every((n) => n.channelId === "ach_a"),
		).toBe(true);
	});

	it("links the alert in the message when PUBLIC_BASE_URL is set", async () => {
		const fetchImpl = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(null, { status: 204 }),
		);
		const deps = testDeps({
			now: () => T,
			fetch: fetchImpl as unknown as typeof fetch,
			env: testEnv({ PUBLIC_BASE_URL: "https://hooks.example.com/" }),
		});
		await addChannel(deps, "ach_a");
		const p = await seedPipeline(deps);
		await seedNotifications(deps, p.destination.id, p.project.id, 1);
		await sendPendingNotifications(deps, logger);
		const body = String(fetchImpl.mock.calls[0]?.[1]?.body);
		expect(body).toContain("https://hooks.example.com/alerts/alr_out");
	});
});
