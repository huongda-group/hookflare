import {
	type AlertChannel,
	type ChannelTestResult,
	createAlertChannelRequest,
	operateRequest,
	patchAlertChannelRequest,
} from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { AppBindings } from "../../app";
import {
	formatAlertMessage,
	openChannelConfig,
	sealChannelConfig,
	sendAlert,
} from "../../core/alert-channels";
import { alertChannels, alertNotifications } from "../../core/db/schema";
import { newId } from "../../core/ids";
import { requirePermission } from "../auth/permission";
import { auditStmt, readJson, readOptionalJson } from "../http";

type Row = typeof alertChannels.$inferSelect;

export function toAlertChannel(r: Row): AlertChannel {
	return {
		id: r.id,
		name: r.name,
		type: r.type,
		enabled: r.enabled,
		rules: JSON.parse(r.rulesJson),
		project_ids: JSON.parse(r.projectIdsJson),
		config_fingerprint: r.configFingerprint,
		chat_id: r.chatId,
		created_at: r.createdAt,
		updated_at: r.updatedAt,
	};
}

async function loadChannel(
	c: Context<AppBindings>,
	id: string,
): Promise<Row | undefined> {
	return c.var.deps.db
		.select()
		.from(alertChannels)
		.where(eq(alertChannels.id, id))
		.get();
}

/** Spec §6.5. Configs are write-only (M5-9). */
export function alertChannelRoutes() {
	const routes = new Hono<AppBindings>();
	const guard = requirePermission("settings.manage");

	routes.get("/", guard, async (c) => {
		const rows = await c.var.deps.db
			.select()
			.from(alertChannels)
			.orderBy(alertChannels.createdAt);
		return c.json({ data: rows.map(toAlertChannel) });
	});

	routes.post("/", guard, async (c) => {
		const body = await readJson(c, createAlertChannelRequest);
		if (!body.ok) return body.response;
		const { db, env, now } = c.var.deps;
		const v = body.value;
		const at = now();
		const id = newId("ach", at);
		const row: Row = {
			id,
			name: v.name,
			type: v.config.type,
			...(await sealChannelConfig(env, id, v.config)),
			enabled: v.enabled,
			rulesJson: JSON.stringify(v.rules),
			projectIdsJson: JSON.stringify(v.project_ids),
			createdAt: at,
			updatedAt: at,
		};
		await db.batch([
			db.insert(alertChannels).values(row),
			auditStmt(c, {
				action: "alert_channel.created",
				resourceType: "alert_channel",
				resourceId: id,
				reason: v.reason,
				diff: { after: toAlertChannel(row) },
			}),
		]);
		return c.json(toAlertChannel(row), 201);
	});

	routes.patch("/:id", guard, async (c) => {
		const body = await readJson(c, patchAlertChannelRequest);
		if (!body.ok) return body.response;
		const before = await loadChannel(c, c.req.param("id"));
		if (!before) return c.json({ error: "not_found" }, 404);
		const v = body.value;
		if (v.config && v.config.type !== before.type)
			return c.json({ error: "config_type_mismatch" }, 400);
		const { db, env, now } = c.var.deps;
		const after: Row = {
			...before,
			...(v.name !== undefined ? { name: v.name } : {}),
			...(v.enabled !== undefined ? { enabled: v.enabled } : {}),
			...(v.rules !== undefined ? { rulesJson: JSON.stringify(v.rules) } : {}),
			...(v.project_ids !== undefined
				? { projectIdsJson: JSON.stringify(v.project_ids) }
				: {}),
			...(v.config ? await sealChannelConfig(env, before.id, v.config) : {}),
			updatedAt: Math.max(now(), before.updatedAt + 1),
		};
		await db.batch([
			db
				.update(alertChannels)
				.set(after)
				.where(eq(alertChannels.id, before.id)),
			auditStmt(c, {
				action: "alert_channel.updated",
				resourceType: "alert_channel",
				resourceId: before.id,
				reason: v.reason,
				diff: {
					before: toAlertChannel(before),
					after: toAlertChannel(after),
					config_replaced: Boolean(v.config),
				},
			}),
		]);
		return c.json(toAlertChannel(after));
	});

	routes.delete("/:id", guard, async (c) => {
		const reasonBody = await readOptionalJson(c, operateRequest);
		if (!reasonBody.ok) return reasonBody.response;
		const before = await loadChannel(c, c.req.param("id"));
		if (!before) return c.json({ error: "not_found" }, 404);
		const { db } = c.var.deps;
		await db.batch([
			db
				.delete(alertNotifications)
				.where(eq(alertNotifications.channelId, before.id)),
			db.delete(alertChannels).where(eq(alertChannels.id, before.id)),
			auditStmt(c, {
				action: "alert_channel.deleted",
				resourceType: "alert_channel",
				resourceId: before.id,
				reason: reasonBody.value.reason,
				diff: { before: toAlertChannel(before) },
			}),
		]);
		return c.body(null, 204);
	});

	/** Synchronous; writes no incident or notification (spec §6.5). */
	routes.post("/:id/test", guard, async (c) => {
		const ch = await loadChannel(c, c.req.param("id"));
		if (!ch) return c.json({ error: "not_found" }, 404);
		const { db, env, fetch } = c.var.deps;
		const config = await openChannelConfig(env, ch.id, ch.configEnc);
		const text = formatAlertMessage({
			kind: "test",
			rule: null,
			resourceLabel: ch.name,
			projectLabel: null,
			details: {},
			link: null,
		});
		const r = await sendAlert(fetch, config, text);
		const result: ChannelTestResult = r.ok
			? { ok: true, error: null }
			: { ok: false, error: r.error };
		await db.batch([
			auditStmt(c, {
				action: "alert_channel.tested",
				resourceType: "alert_channel",
				resourceId: ch.id,
				diff: { result },
			}),
		]);
		return c.json(result);
	});

	return routes;
}
