import { DEFAULT_ALERT_RULES } from "@hookflare/shared";
import { eq } from "drizzle-orm";
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
	destinations,
	settings,
} from "../../src/core/db/schema";
import { createLogger } from "../../src/core/log";
import { clearSettingsCache } from "../../src/core/settings";
import type { Deps } from "../../src/deps";
import {
	MAX_CHANGES_PER_RUN,
	runAlerts,
	sendPendingNotifications,
} from "../../src/jobs/alerts/job";
import { DEAD_CURSOR_KEY } from "../../src/jobs/alerts/rules";
import { resetAlerts } from "../helpers/alerts";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const logger = createLogger({ LOG_LEVEL: "error" });
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
		const [resolved] = await incidents(deps, p.destination.id);
		expect(resolved.status).toBe("resolved");
		expect((await notes(deps, open.id)).map((n) => n.kind)).toEqual([
			"opened",
			"resolved",
		]);
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
});
