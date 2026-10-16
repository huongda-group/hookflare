import {
	type AlertRules,
	patchSettingsRequest,
	type Settings,
	type StorageSettings,
} from "@hookflare/shared";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { auditInsertIfChanged } from "../../core/audit";
import {
	ALERT_RULES_SETTING,
	clearSettingsCache,
	RETRY_DEFAULTS_KEY,
	readRetryDefaults,
	readSetting,
	STORAGE_SETTING,
	toRetryDefaults,
	upsertSetting,
} from "../../core/settings";
import type { Db } from "../../deps";
import { requirePermission } from "../auth/permission";
import { readJson } from "../http";

async function readAll(db: Db) {
	const [retry, alertRules, storage] = await Promise.all([
		readRetryDefaults(db),
		readSetting(db, ALERT_RULES_SETTING),
		readSetting(db, STORAGE_SETTING),
	]);
	return { retry, alertRules, storage };
}

function toSettings(s: Awaited<ReturnType<typeof readAll>>): Settings {
	return {
		retry_defaults: toRetryDefaults(s.retry.policy),
		updated_at: s.retry.updatedAt,
		alert_rules: s.alertRules.value,
		alert_rules_updated_at: s.alertRules.updatedAt,
		storage: s.storage.value,
		storage_updated_at: s.storage.updatedAt,
		archive_last_run: null,
	};
}

/** Spec §7.3 (M4) + §6.5 (M5b). Every role reads; only admins write. */
export function settingsRoutes() {
	const routes = new Hono<AppBindings>();

	routes.get("/", requirePermission("events.read"), async (c) => {
		const s = await readAll(c.var.deps.db);
		if (s.retry.corrupt)
			c.var.logger.warn("settings.retry_defaults_invalid", {});
		if (s.alertRules.corrupt)
			c.var.logger.warn("settings.alert_rules_invalid", {});
		if (s.storage.corrupt) c.var.logger.warn("settings.storage_invalid", {});
		return c.json({ ...toSettings(s), archive_last_run: null });
	});

	routes.patch("/", requirePermission("settings.manage"), async (c) => {
		const body = await readJson(c, patchSettingsRequest);
		if (!body.ok) return body.response;
		const { db, now } = c.var.deps;
		const before = await readAll(db);
		const actor = c.var.actor?.email ?? "";
		const reason = body.value.reason;
		// Each section is its own compare-and-swap row; updated_at must move even
		// when two writes share a millisecond.
		const sections: {
			key: string;
			before: unknown;
			after: unknown;
			version: number | null;
		}[] = [];
		if (body.value.retry_defaults) {
			sections.push({
				key: RETRY_DEFAULTS_KEY,
				before: toRetryDefaults(before.retry.policy),
				after: body.value.retry_defaults,
				version: before.retry.updatedAt,
			});
		}
		if (body.value.alert_rules) {
			sections.push({
				key: ALERT_RULES_SETTING.key,
				before: before.alertRules.value,
				after: body.value.alert_rules satisfies AlertRules,
				version: before.alertRules.updatedAt,
			});
		}
		if (body.value.storage) {
			sections.push({
				key: STORAGE_SETTING.key,
				before: before.storage.value,
				after: body.value.storage satisfies StorageSettings,
				version: before.storage.updatedAt,
			});
		}
		const stmts = sections.flatMap((s) => {
			const ts = Math.max(now(), (s.version ?? 0) + 1);
			return [
				upsertSetting(db, s.key, s.after, ts, s.version),
				auditInsertIfChanged(db, {
					actor,
					action: "settings.updated",
					resourceType: "settings",
					resourceId: s.key,
					reason,
					diff: { before: s.before, after: s.after },
					at: ts,
				}),
			];
		});
		const results = await db.batch(
			stmts as unknown as Parameters<typeof db.batch>[0],
		);
		// Another PATCH landed between our read and write: `before` would be stale.
		// D1 batches are atomic, but an empty RETURNING does not roll back; check each upsert.
		const conflict = sections.some(
			(_, i) => (results[i * 2] as unknown[]).length === 0,
		);
		if (conflict) return c.json({ error: "conflict" }, 409);
		clearSettingsCache();
		return c.json(toSettings(await readAll(db)));
	});

	return routes;
}
