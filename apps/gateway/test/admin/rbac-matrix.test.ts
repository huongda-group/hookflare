import type { Permission, Role } from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { clearAccessKeyCache } from "../../src/admin/auth/access";
import {
	alertChannels,
	alerts,
	archiveParts,
	settings,
} from "../../src/core/db/schema";
import { newId } from "../../src/core/ids";
import { ROLE_PERMISSIONS } from "../../src/core/rbac";
import {
	clearSettingsCache,
	RETRY_DEFAULTS_KEY,
} from "../../src/core/settings";
import { adminApp } from "../helpers/admin";
import { seedBatch } from "../helpers/archive";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

// Each adminApp mints fresh keys under the same kid.
beforeEach(async () => {
	clearAccessKeyCache();
	clearSettingsCache();
	const deps = testDeps();
	await deps.db.delete(settings).where(eq(settings.key, RETRY_DEFAULTS_KEY));
});

type Case = {
	method: string;
	path: string;
	permission: Permission;
	body?: unknown;
};

/** One request per guarded endpoint (spec §6.3). IDs are filled per test. */
function cases(ids: {
	project: string;
	source: string;
	destination: string;
	event: string;
	delivery: string;
	alert: string;
	channel: string;
	archive: string;
}): Case[] {
	return [
		{ method: "GET", path: "/projects", permission: "events.read" },
		{
			method: "GET",
			path: `/projects/${ids.project}`,
			permission: "events.read",
		},
		{ method: "GET", path: "/sources", permission: "events.read" },
		{
			method: "GET",
			path: `/sources/${ids.source}`,
			permission: "events.read",
		},
		{ method: "GET", path: "/destinations", permission: "events.read" },
		{
			method: "GET",
			path: `/destinations/${ids.destination}`,
			permission: "events.read",
		},
		{
			method: "GET",
			path: `/destinations/${ids.destination}/tests`,
			permission: "events.read",
		},
		{ method: "GET", path: "/events", permission: "events.read" },
		{ method: "GET", path: `/events/${ids.event}`, permission: "events.read" },
		{
			method: "GET",
			path: `/events/${ids.event}/deliveries`,
			permission: "events.read",
		},
		{ method: "GET", path: "/failures", permission: "events.read" },
		{
			method: "GET",
			path: `/events/${ids.event}/payload`,
			permission: "payload.read",
		},
		{
			method: "POST",
			path: `/events/${ids.event}/replay`,
			permission: "deliveries.replay",
			body: { reason: "r" },
		},
		{
			method: "POST",
			path: "/failures/replay",
			permission: "deliveries.replay",
			body: { delivery_ids: [ids.delivery], reason: "r" },
		},
		{
			method: "POST",
			path: `/destinations/${ids.destination}/pause`,
			permission: "destinations.operate",
		},
		{
			method: "POST",
			path: `/destinations/${ids.destination}/resume`,
			permission: "destinations.operate",
		},
		{
			method: "POST",
			path: `/destinations/${ids.destination}/test`,
			permission: "destinations.operate",
		},
		{ method: "POST", path: "/projects", permission: "config.write", body: {} },
		{
			method: "PATCH",
			path: `/projects/${ids.project}`,
			permission: "config.write",
			body: {},
		},
		{ method: "POST", path: "/sources", permission: "config.write", body: {} },
		{
			method: "PATCH",
			path: `/sources/${ids.source}`,
			permission: "config.write",
			body: {},
		},
		{
			method: "POST",
			path: `/sources/${ids.source}/rotate-secret`,
			permission: "config.write",
		},
		{
			method: "POST",
			path: "/destinations",
			permission: "config.write",
			body: {},
		},
		{
			method: "PATCH",
			path: `/destinations/${ids.destination}`,
			permission: "config.write",
			body: {},
		},
		{
			method: "POST",
			path: `/destinations/${ids.destination}/rotate-secret`,
			permission: "config.write",
		},
		{ method: "GET", path: "/users", permission: "users.manage" },
		{ method: "POST", path: "/users", permission: "users.manage", body: {} },
		{
			method: "PATCH",
			path: "/users/nobody@example.com",
			permission: "users.manage",
			body: {},
		},
		{ method: "GET", path: "/audit-logs", permission: "audit.read" },
		{ method: "GET", path: "/overview", permission: "events.read" },
		{ method: "GET", path: "/alerts", permission: "events.read" },
		{ method: "GET", path: `/alerts/${ids.alert}`, permission: "events.read" },
		{ method: "GET", path: "/alert-channels", permission: "settings.manage" },
		{
			method: "POST",
			path: "/alert-channels",
			permission: "settings.manage",
			body: {
				name: "x",
				config: {
					type: "discord",
					url: "https://discord.com/api/webhooks/1/a",
				},
			},
		},
		{
			method: "PATCH",
			path: `/alert-channels/${ids.channel}`,
			permission: "settings.manage",
			body: { enabled: false },
		},
		{
			method: "POST",
			path: `/alert-channels/${ids.channel}/test`,
			permission: "settings.manage",
		},
		{
			method: "DELETE",
			path: `/alert-channels/${ids.channel}`,
			permission: "settings.manage",
		},
		{ method: "GET", path: "/destinations/stats", permission: "events.read" },
		{ method: "GET", path: "/archives", permission: "events.read" },
		{
			method: "GET",
			path: "/archives/preview?hot_retention_days=30&failed_retention_days=90",
			permission: "settings.manage",
		},
		{
			method: "GET",
			path: `/archives/${ids.archive}/parts/1`,
			permission: "payload.read",
		},
		{
			method: "POST",
			path: "/archives/run",
			permission: "settings.manage",
			body: {},
		},
		{ method: "GET", path: "/settings", permission: "events.read" },
		{
			method: "PATCH",
			path: "/settings",
			permission: "settings.manage",
			body: {
				retry_defaults: {
					timeout_ms: 10_000,
					max_attempts: 20,
					backoff_base_s: 30,
					backoff_max_s: 21_600,
				},
			},
		},
	];
}

describe("RBAC matrix (spec §6.2–6.3)", () => {
	for (const role of ["viewer", "operator", "admin"] as Role[]) {
		it(`enforces ${role} permissions on every endpoint`, async () => {
			const deps = testDeps();
			const p = await seedPipeline(deps);
			const { eventId, deliveryId } = await seedDelivery(deps, p, {
				status: "dead",
			});
			const now = deps.now();
			const channelId = newId("ach", now);
			await deps.db.insert(alertChannels).values({
				id: channelId,
				name: "rbac",
				type: "discord",
				configEnc: "enc",
				configFingerprint: "deadbeef",
				createdAt: now,
				updatedAt: now,
			});
			const alertId = newId("alr", now);
			await deps.db.insert(alerts).values({
				id: alertId,
				rule: "new_dead",
				resourceType: "destination",
				resourceId: p.destination.id,
				projectId: p.project.id,
				status: "open",
				openedAt: now,
				detailsJson: "{}",
			});
			const archiveBatch = await seedBatch(deps, {
				status: "verified",
				withFiles: true,
			});
			const archiveKey = `archive/2026/01/02/${archiveBatch.id}/part-0001.ndjson.gz`;
			await deps.payloads.put(archiveKey, new Uint8Array([31, 139, 8]));
			await deps.db.insert(archiveParts).values({
				batchId: archiveBatch.id,
				partNo: 1,
				r2Key: archiveKey,
				itemCount: 1,
				bytes: 3,
				sha256: null,
				firstId: "evt_a",
				lastId: "evt_a",
			});
			const api = await adminApp(deps, { role });
			for (const k of cases({
				project: p.project.id,
				source: p.source.id,
				destination: p.destination.id,
				event: eventId,
				delivery: deliveryId,
				alert: alertId,
				channel: channelId,
				archive: archiveBatch.id,
			})) {
				const res = await api.request(k.method, k.path, k.body);
				const allowed = ROLE_PERMISSIONS[role].includes(k.permission);
				if (allowed) {
					expect(res.status, `${role} ${k.method} ${k.path}`).not.toBe(403);
				} else {
					expect(res.status, `${role} ${k.method} ${k.path}`).toBe(403);
					expect(await res.json()).toEqual({
						error: "forbidden",
						required: k.permission,
					});
				}
			}
		});
	}
});
