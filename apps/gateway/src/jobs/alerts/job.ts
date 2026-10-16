import type { AlertChannelConfig, AlertRule } from "@hookflare/shared";
import { and, eq, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import {
	formatAlertMessage,
	openChannelConfig,
	sendAlert,
} from "../../core/alert-channels";
import {
	type BatchItem,
	keyOf,
	listChannelRoutes,
	listOpenAlerts,
	matchChannels,
	openAlertStatements,
	remindAlertStatements,
	resolveAlertStatements,
	updateDetailsStatement,
} from "../../core/db/alerts";
import {
	alertChannels,
	alertNotifications,
	alerts,
	destinations,
	projects,
} from "../../core/db/schema";
import type { Logger } from "../../core/log";
import { loadAlertRules } from "../../core/settings";
import type { Deps } from "../../deps";
import { deadCursorStatement, evaluateRules } from "./rules";

export const SEND_BATCH = 50;
export const SEND_CONCURRENCY = 10;
/**
 * No new send starts once a run has spent this long; with the 5 s send
 * timeout every claim settles well inside CLAIM_STALE_MS, so the next
 * minute's run never reclaims (and re-sends) a row this run still owns.
 */
export const SEND_BUDGET_MS = 30_000;
export const MAX_TRIES = 3;
export const CLAIM_STALE_MS = 60_000;
/** Per run and per kind (opens, resolves, reminders); the rest wait for the next run. */
export const MAX_CHANGES_PER_RUN = 100;

export type AlertsRunResult = {
	opened: number;
	resolved: number;
	reminded: number;
	sent: number;
	failed: number;
};

const run = (deps: Deps, stmts: BatchItem[]) =>
	stmts.length
		? deps.db.batch(stmts as [BatchItem, ...BatchItem[]])
		: Promise.resolve([]);

/** Spec §6.3 steps 1–5. Each incident change is its own batch, so one failure never blocks the rest. */
export async function runAlerts(
	deps: Deps,
	logger: Logger,
): Promise<AlertsRunResult> {
	const now = deps.now();
	const rules = await loadAlertRules(deps);
	const [open, routes] = await Promise.all([
		listOpenAlerts(deps.db),
		listChannelRoutes(deps.db),
	]);
	const { active, deadCursor } = await evaluateRules(deps, rules, open);
	const activeByKey = new Map(active.map((a) => [keyOf(a), a]));
	const openByKey = new Map(open.map((o) => [keyOf(o), o]));
	const result: AlertsRunResult = {
		opened: 0,
		resolved: 0,
		reminded: 0,
		sent: 0,
		failed: 0,
	};

	// 2. Open (and, for new_dead, add fresh dead deliveries to incidents that are already open).
	// new_dead is bounded by the rule's own scan (≤ 100 destinations per run).
	const deadStmts: BatchItem[] = [
		deadCursorStatement(deps.db, deadCursor.to, now),
	];
	let deadOpened = 0;
	let opens = 0;
	for (const a of active) {
		const existing = openByKey.get(keyOf(a));
		if (existing) {
			// A carry-over only keeps the incident active; a fresh batch is always counted.
			if (a.rule === "new_dead" && !a.carryOver) {
				deadStmts.push(
					updateDetailsStatement(
						deps.db,
						existing.id,
						mergeDead(existing.detailsJson, a.details),
					),
				);
			}
			continue;
		}
		const { stmts } = openAlertStatements(
			deps.db,
			a,
			now,
			matchChannels(routes, a.rule, a.projectId),
		);
		// The dead cursor moves in the same batch as the new_dead opens (spec §6.2).
		if (a.rule === "new_dead") {
			deadStmts.push(...stmts);
			deadOpened++;
		} else if (opens < MAX_CHANGES_PER_RUN) {
			opens++;
			await runSafely(deps, logger, stmts, a, () => result.opened++);
		}
	}
	await runSafely(deps, logger, deadStmts, null, () => {
		result.opened += deadOpened;
	});

	// 3. Resolve.
	let resolves = 0;
	for (const o of open) {
		if (activeByKey.has(keyOf(o))) continue;
		if (resolves++ >= MAX_CHANGES_PER_RUN) break;
		const stmts = resolveAlertStatements(
			deps.db,
			o,
			now,
			matchChannels(routes, o.rule, o.projectId),
		);
		await runSafely(deps, logger, stmts, o, () => result.resolved++);
	}

	// 4. Remind.
	if (rules.reminder_s > 0) {
		let reminds = 0;
		for (const o of open) {
			if (!activeByKey.has(keyOf(o))) continue;
			const last = o.lastNotifiedAt ?? o.openedAt;
			if (last > now - rules.reminder_s * 1000) continue;
			if (reminds++ >= MAX_CHANGES_PER_RUN) break;
			const stmts = remindAlertStatements(
				deps.db,
				o,
				now,
				matchChannels(routes, o.rule, o.projectId),
			);
			await runSafely(deps, logger, stmts, o, () => result.reminded++);
		}
	}

	// 5. Send.
	const sent = await sendPendingNotifications(deps, logger);
	result.sent = sent.sent;
	result.failed = sent.failed;
	return result;
}

function mergeDead(
	previousJson: string,
	next: Record<string, unknown>,
): Record<string, unknown> {
	let prev: { new_dead?: number; delivery_ids?: string[] } = {};
	try {
		prev = JSON.parse(previousJson) as typeof prev;
	} catch {
		// Corrupt stored details: start over from this batch.
	}
	const n = next as {
		new_dead: number;
		delivery_ids: string[];
		last_dead_at: number;
	};
	return {
		new_dead: (prev.new_dead ?? 0) + n.new_dead,
		delivery_ids: [...n.delivery_ids, ...(prev.delivery_ids ?? [])].slice(0, 5),
		last_dead_at: n.last_dead_at,
	};
}

async function runSafely(
	deps: Deps,
	logger: Logger,
	stmts: BatchItem[],
	subject: { rule: string; resourceId: string } | null,
	onSuccess: () => void,
) {
	try {
		await run(deps, stmts);
		onSuccess();
	} catch (err) {
		logger.error("alerts.write_failed", {
			rule: subject?.rule,
			resource_id: subject?.resourceId,
			error: String(err),
		});
	}
}

type Claimed = typeof alertNotifications.$inferSelect;
type SendOutcome = { ok: true } | { ok: false; error: string; final?: boolean };

/**
 * M5-14: claim, send with bounded concurrency and a 5 s timeout, and settle
 * each row on its own. Every settle is fenced by this run's claim
 * (status = 'sending' AND claimed_at = claimedAt), so a run whose claim was
 * taken over never overwrites the newer run's result.
 */
export async function sendPendingNotifications(
	deps: Deps,
	logger: Logger,
): Promise<{ sent: number; failed: number }> {
	const claimedAt = deps.now();
	const stale = claimedAt - CLAIM_STALE_MS;
	// A claim that died after its last try can never be sent again.
	await deps.db
		.update(alertNotifications)
		.set({ status: "failed", lastError: "claim_expired" })
		.where(
			and(
				eq(alertNotifications.status, "sending"),
				lt(alertNotifications.claimedAt, stale),
				sql`${alertNotifications.tries} >= ${MAX_TRIES}`,
			),
		);
	const claimed = await deps.db
		.update(alertNotifications)
		.set({ status: "sending", claimedAt, tries: sql`tries + 1` })
		.where(
			inArray(
				alertNotifications.id,
				deps.db
					.select({ id: alertNotifications.id })
					.from(alertNotifications)
					.where(
						and(
							or(
								eq(alertNotifications.status, "pending"),
								and(
									eq(alertNotifications.status, "sending"),
									lt(alertNotifications.claimedAt, stale),
								),
							),
							sql`${alertNotifications.tries} < ${MAX_TRIES}`,
						),
					)
					.orderBy(alertNotifications.createdAt)
					.limit(SEND_BATCH),
			),
		)
		.returning();
	claimed.sort((a, b) => a.createdAt - b.createdAt);
	const mine = (extra: SQL) =>
		and(
			extra,
			eq(alertNotifications.status, "sending"),
			eq(alertNotifications.claimedAt, claimedAt),
		);
	const totals = { sent: 0, failed: 0 };
	for (let i = 0; i < claimed.length; i += SEND_CONCURRENCY) {
		if (deps.now() - claimedAt >= SEND_BUDGET_MS) {
			// Out of time: hand the rest back untouched; they were never tried.
			const rest = claimed.slice(i).map((n) => n.id);
			try {
				await deps.db
					.update(alertNotifications)
					.set({
						status: "pending",
						claimedAt: null,
						tries: sql`tries - 1`,
					})
					.where(mine(inArray(alertNotifications.id, rest)) as SQL);
			} catch (err) {
				logger.error("alerts.release_failed", { error: String(err) });
			}
			break;
		}
		await Promise.all(
			claimed
				.slice(i, i + SEND_CONCURRENCY)
				.map((n) => sendAndSettle(deps, logger, n, mine, totals)),
		);
	}
	return totals;
}

async function sendAndSettle(
	deps: Deps,
	logger: Logger,
	n: Claimed,
	mine: (extra: SQL) => SQL | undefined,
	totals: { sent: number; failed: number },
) {
	let outcome: SendOutcome;
	try {
		outcome = await sendOne(deps, n.alertId, n.channelId, n.kind);
	} catch (err) {
		outcome = { ok: false, error: String(err).slice(0, 200) };
	}
	const where = mine(eq(alertNotifications.id, n.id)) as SQL;
	try {
		if (outcome.ok) {
			totals.sent++;
			await deps.db
				.update(alertNotifications)
				.set({ status: "sent", sentAt: deps.now(), lastError: null })
				.where(where);
			return;
		}
		const final = outcome.final === true || n.tries >= MAX_TRIES;
		if (final) totals.failed++;
		logger.warn("alerts.send_failed", {
			notification_id: n.id,
			channel_id: n.channelId,
			tries: n.tries,
			error: outcome.error,
		});
		await deps.db
			.update(alertNotifications)
			.set({ status: final ? "failed" : "pending", lastError: outcome.error })
			.where(where);
	} catch (err) {
		// The claim stays; the next run past CLAIM_STALE_MS takes it over.
		logger.error("alerts.settle_failed", {
			notification_id: n.id,
			error: String(err),
		});
	}
}

async function sendOne(
	deps: Deps,
	alertId: string,
	channelId: string,
	kind: "opened" | "reminder" | "resolved",
): Promise<SendOutcome> {
	const [row] = await deps.db
		.select({
			alert: alerts,
			channel: alertChannels,
			destinationName: destinations.name,
			projectName: projects.name,
		})
		.from(alerts)
		.innerJoin(alertChannels, eq(alertChannels.id, channelId))
		.leftJoin(
			destinations,
			and(
				eq(alerts.resourceType, "destination"),
				eq(destinations.id, alerts.resourceId),
			),
		)
		.leftJoin(projects, eq(projects.id, alerts.projectId))
		.where(eq(alerts.id, alertId));
	if (!row) return { ok: false, error: "channel_or_alert_missing" };
	if (!row.channel.enabled)
		return { ok: false, error: "channel_disabled", final: true };
	let config: AlertChannelConfig;
	try {
		config = await openChannelConfig(
			deps.env,
			channelId,
			row.channel.configEnc,
		);
	} catch {
		return { ok: false, error: "config_unreadable" };
	}
	const a = row.alert;
	const base = deps.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
	const text = formatAlertMessage({
		kind,
		rule: a.rule as AlertRule,
		resourceLabel:
			a.resourceType === "system"
				? `system / ${a.resourceId}`
				: (row.destinationName ?? a.resourceId),
		projectLabel: row.projectName ?? a.projectId,
		details: JSON.parse(a.detailsJson) as Record<string, unknown>,
		link: base ? `${base}/alerts/${a.id}` : null,
	});
	return sendAlert(deps.fetch, config, text);
}
