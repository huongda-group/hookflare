import { type AuditLog, auditLogQuery, type Page } from "@hookflare/shared";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { searchAuditLogs } from "../../core/db/audit-logs";
import { requirePermission } from "../auth/permission";
import { decodeCursor, encodeCursor } from "../cursor";
import { badCursor, readQuery } from "../http";

export function auditLogRoutes() {
	const routes = new Hono<AppBindings>();

	routes.get("/", requirePermission("audit.read"), async (c) => {
		const q = readQuery(c, auditLogQuery);
		if (!q.ok) return q.response;
		const after = decodeCursor(q.value.cursor);
		if (after === "invalid") return badCursor(c);
		const rows = await searchAuditLogs(c.var.deps.db, {
			actor: q.value.actor,
			resourceType: q.value.resource_type,
			resourceId: q.value.resource_id,
			action: q.value.action,
			from: q.value.from,
			to: q.value.to,
			after: after ?? undefined,
			limit: q.value.limit,
		});
		const page = rows.slice(0, q.value.limit);
		const last = page.at(-1);
		return c.json({
			data: page.map(
				(r): AuditLog => ({
					id: r.id,
					actor: r.actor,
					action: r.action,
					resource_type: r.resourceType,
					resource_id: r.resourceId,
					reason: r.reason,
					diff: r.diffJson ?? null,
					at: r.at,
				}),
			),
			next_cursor:
				rows.length > q.value.limit && last
					? encodeCursor(last.at, last.id)
					: null,
		} satisfies Page<AuditLog>);
	});

	return routes;
}
