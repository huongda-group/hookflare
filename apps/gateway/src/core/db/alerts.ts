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
	carryOver?: boolean;
	updateDetails?: boolean;
};
export type OpenAlertRow = typeof alerts.$inferSelect;
export type ChannelRoute = {
	id: string;
	rules: string[];
	projectIds: string[];
};

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
				WHERE EXISTS (SELECT 1 FROM alerts WHERE id = ${alert.id} AND resolved_at = ${now})
				AND NOT EXISTS (SELECT 1 FROM alert_notifications WHERE alert_id = ${alert.id} AND channel_id = ${n.channelId} AND kind = 'resolved' AND created_at = ${now})`),
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
			.where(
				and(
					eq(alerts.id, alert.id),
					eq(alerts.status, "open"),
					alert.lastNotifiedAt === null
						? sql`last_notified_at IS NULL`
						: eq(alerts.lastNotifiedAt, alert.lastNotifiedAt),
				),
			),
		...notificationRows(alert.id, "reminder", now, channelIds).map((n) =>
			db.insert(alertNotifications).select(sql`
				SELECT ${n.id}, ${n.alertId}, ${n.channelId}, ${n.kind}, 'pending', 0, NULL, ${n.createdAt}, NULL, NULL
				WHERE EXISTS (SELECT 1 FROM alerts WHERE id = ${alert.id} AND status = 'open' AND last_notified_at = ${now})
				AND NOT EXISTS (SELECT 1 FROM alert_notifications WHERE alert_id = ${alert.id} AND channel_id = ${n.channelId} AND kind = 'reminder' AND created_at = ${now})`),
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
