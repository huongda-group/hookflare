import type { AlertRule } from "@hookflare/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../deps";
import { newId } from "../ids";
import { alertChannels, alertNotifications, alerts } from "./schema";

export type BatchItem = Parameters<Db["batch"]>[0][number];
export type AlertKey = {
	rule: AlertRule;
	resourceType: "destination" | "system";
	resourceId: string;
};
export type ActiveAlert = AlertKey & {
	projectId: string | null;
	details: Record<string, unknown>;
};
export type OpenAlertRow = typeof alerts.$inferSelect;
export type ChannelRoute = {
	id: string;
	rules: string[];
	projectIds: string[];
};

/** Takes plain strings so OpenAlertRow (rule: string) fits without a cast. */
export const keyOf = (k: {
	rule: string;
	resourceType: string;
	resourceId: string;
}) => `${k.rule}|${k.resourceType}|${k.resourceId}`;

export function listOpenAlerts(db: Db): Promise<OpenAlertRow[]> {
	return db.select().from(alerts).where(eq(alerts.status, "open"));
}

export async function listChannelRoutes(db: Db): Promise<ChannelRoute[]> {
	const rows = await db
		.select({
			id: alertChannels.id,
			rulesJson: alertChannels.rulesJson,
			projectIdsJson: alertChannels.projectIdsJson,
		})
		.from(alertChannels)
		.where(eq(alertChannels.enabled, true))
		.orderBy(alertChannels.id);
	return rows.map((r) => ({
		id: r.id,
		rules: JSON.parse(r.rulesJson) as string[],
		projectIds: JSON.parse(r.projectIdsJson) as string[],
	}));
}

/** Spec §6.3: empty = all; incidents without a project only reach unscoped channels. */
export function matchChannels(
	routes: ChannelRoute[],
	rule: string,
	projectId: string | null,
): string[] {
	return routes
		.filter((r) => r.rules.length === 0 || r.rules.includes(rule))
		.filter(
			(r) =>
				r.projectIds.length === 0 ||
				(projectId !== null && r.projectIds.includes(projectId)),
		)
		.map((r) => r.id);
}

function notificationRows(
	alertId: string,
	kind: "opened" | "reminder" | "resolved",
	now: number,
	channelIds: string[],
) {
	return channelIds.map((channelId) => ({
		id: newId("ant", now),
		alertId,
		channelId,
		kind,
		status: "pending" as const,
		createdAt: now,
	}));
}

/**
 * M5-11: the partial unique index makes a concurrent open a no-op, and the
 * notifications only land when this run's row exists (same batch).
 */
export function openAlertStatements(
	db: Db,
	a: ActiveAlert,
	now: number,
	channelIds: string[],
) {
	const alertId = newId("alr", now);
	const stmts: BatchItem[] = [
		db
			.insert(alerts)
			.values({
				id: alertId,
				rule: a.rule,
				resourceType: a.resourceType,
				resourceId: a.resourceId,
				projectId: a.projectId,
				status: "open",
				openedAt: now,
				lastNotifiedAt: channelIds.length ? now : null,
				detailsJson: JSON.stringify(a.details),
			})
			.onConflictDoNothing(),
		...notificationRows(alertId, "opened", now, channelIds).map((n) =>
			db.insert(alertNotifications).select(sql`
				SELECT ${n.id}, ${n.alertId}, ${n.channelId}, ${n.kind}, 'pending', 0, NULL, ${n.createdAt}, NULL, NULL
				WHERE EXISTS (SELECT 1 FROM alerts WHERE id = ${alertId})`),
		),
	];
	return { alertId, stmts };
}

export function resolveAlertStatements(
	db: Db,
	alert: OpenAlertRow,
	now: number,
	channelIds: string[],
): BatchItem[] {
	return [
		db
			.update(alerts)
			.set({ status: "resolved", resolvedAt: now })
			.where(and(eq(alerts.id, alert.id), eq(alerts.status, "open"))),
		...notificationRows(alert.id, "resolved", now, channelIds).map((n) =>
			db.insert(alertNotifications).select(sql`
				SELECT ${n.id}, ${n.alertId}, ${n.channelId}, ${n.kind}, 'pending', 0, NULL, ${n.createdAt}, NULL, NULL
				WHERE EXISTS (SELECT 1 FROM alerts WHERE id = ${alert.id} AND resolved_at = ${now})`),
		),
	];
}

export function remindAlertStatements(
	db: Db,
	alert: OpenAlertRow,
	now: number,
	channelIds: string[],
): BatchItem[] {
	return [
		db
			.update(alerts)
			.set({ lastNotifiedAt: now })
			.where(and(eq(alerts.id, alert.id), eq(alerts.status, "open"))),
		...notificationRows(alert.id, "reminder", now, channelIds).map((n) =>
			db.insert(alertNotifications).values(n),
		),
	];
}

export function updateDetailsStatement(
	db: Db,
	alertId: string,
	details: Record<string, unknown>,
): BatchItem {
	return db
		.update(alerts)
		.set({ detailsJson: JSON.stringify(details) })
		.where(eq(alerts.id, alertId));
}
