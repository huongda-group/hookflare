import type { AlertChannelConfig, AlertRule } from "@hookflare/shared";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
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
import { loadAlertRules, upsertSetting } from "../../core/settings";
import type { Deps } from "../../deps";
import { DEAD_CURSOR_KEY, evaluateRules } from "./rules";

export const SEND_BATCH = 50;
export const MAX_TRIES = 3;
export const CLAIM_STALE_MS = 60_000;

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

	// 2. Open (and, for new_dead, refresh details of incidents that are already open).
	const cursorStmt = upsertSetting(
		deps.db,
		DEAD_CURSOR_KEY,
		{ at: deadCursor.to },
		now,
	);
	const deadStmts: BatchItem[] = [cursorStmt];
	for (const a of active) {
		const existing = openByKey.get(keyOf(a));
		if (existing) {
			if (
				a.rule === "new_dead" &&
				JSON.stringify(a.details) !== existing.detailsJson
			) {
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
		if (a.rule === "new_dead") deadStmts.push(...stmts);
		else await runSafely(deps, logger, stmts, a, () => result.opened++);
	}
	await runSafely(deps, logger, deadStmts, null, () => {
		result.opened += active.filter(
			(a) => a.rule === "new_dead" && !openByKey.has(keyOf(a)),
		).length;
	});

	// 3. Resolve.
	for (const o of open) {
		if (activeByKey.has(keyOf(o))) continue;
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
		for (const o of open) {
			if (!activeByKey.has(keyOf(o))) continue;
			const last = o.lastNotifiedAt ?? o.openedAt;
			if (last > now - rules.reminder_s * 1000) continue;
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
	const prev = JSON.parse(previousJson) as {
		new_dead?: number;
		delivery_ids?: string[];
	};
	const n = next as {
		new_dead: number;
		delivery_ids: string[];
		last_dead_at: number;
	};
	// Quiet-period carry-over returns the stored details unchanged.
	if (!Array.isArray(n.delivery_ids) || n.new_dead === prev.new_dead)
		return next;
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

/** M5-14: claim, send with a 5 s timeout, and settle each row on its own. */
export async function sendPendingNotifications(
	deps: Deps,
	logger: Logger,
): Promise<{ sent: number; failed: number }> {
	const now = deps.now();
	const stale = now - CLAIM_STALE_MS;
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
		.set({ status: "sending", claimedAt: now, tries: sql`tries + 1` })
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
	let sent = 0;
	let failed = 0;
	for (const n of claimed) {
		const outcome = await sendOne(deps, n.alertId, n.channelId, n.kind);
		if (outcome.ok) {
			sent++;
			await deps.db
				.update(alertNotifications)
				.set({ status: "sent", sentAt: deps.now(), lastError: null })
				.where(eq(alertNotifications.id, n.id));
		} else {
			const final = n.tries >= MAX_TRIES;
			if (final) failed++;
			logger.warn("alerts.send_failed", {
				notification_id: n.id,
				channel_id: n.channelId,
				tries: n.tries,
				error: outcome.error,
			});
			await deps.db
				.update(alertNotifications)
				.set({ status: final ? "failed" : "pending", lastError: outcome.error })
				.where(eq(alertNotifications.id, n.id));
		}
	}
	return { sent, failed };
}

async function sendOne(
	deps: Deps,
	alertId: string,
	channelId: string,
	kind: "opened" | "reminder" | "resolved",
) {
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
	if (!row) return { ok: false as const, error: "channel_or_alert_missing" };
	let config: AlertChannelConfig;
	try {
		config = await openChannelConfig(
			deps.env,
			channelId,
			row.channel.configEnc,
		);
	} catch {
		return { ok: false as const, error: "config_unreadable" };
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
