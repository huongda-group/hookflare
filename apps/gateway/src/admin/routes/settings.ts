import { patchSettingsRequest, type Settings } from "@hookflare/shared";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { auditInsertIfChanged } from "../../core/audit";
import {
	clearRetryDefaultsCache,
	RETRY_DEFAULTS_KEY,
	readRetryDefaults,
	toRetryDefaults,
	upsertRetryDefaults,
} from "../../core/settings";
import { requirePermission } from "../auth/permission";
import { readJson } from "../http";

/** Spec §7.3. Every role reads the defaults (the destination form shows them). */
export function settingsRoutes() {
	const routes = new Hono<AppBindings>();

	routes.get("/", requirePermission("events.read"), async (c) => {
		const { policy, updatedAt, corrupt } = await readRetryDefaults(
			c.var.deps.db,
		);
		// The stored row is unusable; deliveries run on DEFAULT_POLICY until an admin saves.
		if (corrupt) c.var.logger.warn("settings.retry_defaults_invalid", {});
		return c.json({
			retry_defaults: toRetryDefaults(policy),
			updated_at: updatedAt,
		} satisfies Settings);
	});

	routes.patch("/", requirePermission("settings.manage"), async (c) => {
		const body = await readJson(c, patchSettingsRequest);
		if (!body.ok) return body.response;
		const { db, now } = c.var.deps;
		const before = await readRetryDefaults(db);
		const ts = now();
		const after = body.value.retry_defaults;
		const [written] = await db.batch([
			upsertRetryDefaults(db, after, ts, before.updatedAt),
			auditInsertIfChanged(db, {
				actor: c.var.actor?.email ?? "",
				action: "settings.updated",
				resourceType: "settings",
				resourceId: RETRY_DEFAULTS_KEY,
				reason: body.value.reason,
				diff: { before: toRetryDefaults(before.policy), after },
				at: ts,
			}),
		]);
		// Another PATCH landed between our read and write: `before` would be stale.
		if (written.length === 0) return c.json({ error: "conflict" }, 409);
		// Other isolates pick the change up within SETTINGS_CACHE_TTL_MS.
		clearRetryDefaultsCache();
		return c.json({ retry_defaults: after, updated_at: ts } satisfies Settings);
	});

	return routes;
}
