import {
	type Alert,
	type AlertDetail,
	type AlertRule,
	alertsQuery,
} from "@hookflare/shared";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import {
	alertChannels,
	alertNotifications,
	alerts,
	destinations,
} from "../../core/db/schema";
import { requirePermission } from "../auth/permission";
import { decodeCursor, encodeCursor } from "../cursor";
import { badCursor, readQuery } from "../http";

type Joined = {
	alert: typeof alerts.$inferSelect;
	destinationName: string | null;
};

function toAlert({ alert: a, destinationName }: Joined): Alert {
	return {
		id: a.id,
		rule: a.rule as AlertRule,
		resource_type: a.resourceType,
		resource_id: a.resourceId,
		resource_name: destinationName,
		project_id: a.projectId,
		status: a.status,
		opened_at: a.openedAt,
		last_notified_at: a.lastNotifiedAt,
		resolved_at: a.resolvedAt,
		details: JSON.parse(a.detailsJson),
	};
}

export function alertRoutes() {
	const routes = new Hono<AppBindings>();
	const guard = requirePermission("events.read");

	routes.get("/", guard, async (c) => {
		const q = readQuery(c, alertsQuery);
		if (!q.ok) return q.response;
		const { status, rule, project_id, limit, cursor } = q.value;
		const after = decodeCursor(cursor);
		if (after === "invalid") return badCursor(c);
		const where: SQL[] = [];
		if (status) where.push(eq(alerts.status, status));
		if (rule) where.push(eq(alerts.rule, rule));
		if (project_id) where.push(eq(alerts.projectId, project_id));
		if (after) {
			where.push(
				or(
					lt(alerts.openedAt, after.at),
					and(eq(alerts.openedAt, after.at), lt(alerts.id, after.id)),
				) as SQL,
			);
		}
		const { db } = c.var.deps;
		const base = db
			.select({ alert: alerts, destinationName: destinations.name })
			.from(alerts)
			.leftJoin(
				destinations,
				and(
					eq(alerts.resourceType, "destination"),
					eq(destinations.id, alerts.resourceId),
				),
			);
		const cond = where.length > 0 ? and(...where) : undefined;
		const rows = await (cond ? base.where(cond) : base)
			.orderBy(desc(alerts.openedAt), desc(alerts.id))
			.limit(limit + 1);
		const page = rows.slice(0, limit);
		const last = page.at(-1);
		return c.json({
			data: page.map(toAlert),
			next_cursor:
				rows.length > limit && last
					? encodeCursor(last.alert.openedAt, last.alert.id)
					: null,
		});
	});

	routes.get("/:id", guard, async (c) => {
		const { db } = c.var.deps;
		const [row] = await db
			.select({ alert: alerts, destinationName: destinations.name })
			.from(alerts)
			.leftJoin(
				destinations,
				and(
					eq(alerts.resourceType, "destination"),
					eq(destinations.id, alerts.resourceId),
				),
			)
			.where(eq(alerts.id, c.req.param("id")));
		if (!row) return c.json({ error: "not_found" }, 404);
		const notes = await db
			.select({ n: alertNotifications, channelName: alertChannels.name })
			.from(alertNotifications)
			.leftJoin(
				alertChannels,
				eq(alertChannels.id, alertNotifications.channelId),
			)
			.where(eq(alertNotifications.alertId, row.alert.id))
			.orderBy(alertNotifications.createdAt, alertNotifications.id);
		return c.json({
			...toAlert(row),
			notifications: notes.map(({ n, channelName }) => ({
				id: n.id,
				channel_id: n.channelId,
				channel_name: channelName,
				kind: n.kind,
				status: n.status,
				tries: n.tries,
				last_error: n.lastError,
				created_at: n.createdAt,
				sent_at: n.sentAt,
			})),
		} satisfies AlertDetail);
	});

	return routes;
}
