import type { Context } from "hono";
import type { AppBindings } from "../app";
import { activeReplays, markQueuedMany } from "../core/db/deliveries";
import { listDestinationStatuses } from "../core/db/destinations";
import { getEventR2Keys } from "../core/db/events";
import { deliveries } from "../core/db/schema";
import { enqueueThenMark } from "../core/enqueue";
import { newId } from "../core/ids";
import type { Deps } from "../deps";
import { auditStmt } from "./http";

export type ReplayTarget = {
	sourceDeliveryId: string;
	eventId: string;
	destinationId: string;
	projectId: string;
};

export type SkipReason =
	| "not_found"
	| "not_failed"
	| "destination_disabled"
	| "payload_missing"
	| "replay_in_progress";

export type Skip = { delivery_id: string; reason: SkipReason };

/**
 * Spec §9.2. Checks in table order; the first failing check names the skip.
 * An R2 error propagates: it is an infra error, never a per-item skip.
 */
export async function precheck(
	deps: Deps,
	targets: ReplayTarget[],
): Promise<{ ready: (ReplayTarget & { paused: boolean })[]; skipped: Skip[] }> {
	const eventIds = [...new Set(targets.map((t) => t.eventId))];
	const statuses = await listDestinationStatuses(deps.db, [
		...new Set(targets.map((t) => t.destinationId)),
	]);
	const r2Keys = await getEventR2Keys(deps.db, eventIds);
	const active = await activeReplays(deps.db, eventIds);
	const present = new Map<string, boolean>();
	const ready: (ReplayTarget & { paused: boolean })[] = [];
	const skipped: Skip[] = [];
	const claimed = new Set<string>();
	for (const t of targets) {
		const skip = (reason: SkipReason) =>
			skipped.push({ delivery_id: t.sourceDeliveryId, reason });
		const status = statuses.get(t.destinationId);
		if (status === "disabled") {
			skip("destination_disabled");
			continue;
		}
		const key = r2Keys.get(t.eventId);
		if (key) {
			if (!present.has(key)) {
				present.set(key, (await deps.payloads.head(key)) !== null);
			}
			if (!present.get(key)) {
				skip("payload_missing");
				continue;
			}
		}
		// Also covers two failures of the same pair in one bulk request.
		const pair = `${t.eventId}|${t.destinationId}`;
		if (active.has(pair) || claimed.has(pair)) {
			skip("replay_in_progress");
			continue;
		}
		claimed.add(pair);
		ready.push({ ...t, paused: status === "paused" });
	}
	return { ready, skipped };
}

/**
 * Spec §9.3: one batch of replay rows plus one audit row, then enqueue the
 * non-paused ones. A failed send leaves rows pending for the reconciler.
 */
export async function writeReplays(
	c: Context<AppBindings>,
	input: {
		ready: (ReplayTarget & { paused: boolean })[];
		skipped: Skip[];
		reason: string;
		resourceType: "event" | "delivery";
		resourceId: string | null;
	},
) {
	const deps = c.var.deps;
	const actor = c.var.actor?.email ?? "";
	const now = deps.now();
	const rows = input.ready.map((t) => ({
		source: t.sourceDeliveryId,
		row: {
			id: newId("dlv", now),
			eventId: t.eventId,
			destinationId: t.destinationId,
			projectId: t.projectId,
			kind: "replay" as const,
			status: t.paused ? ("paused" as const) : ("pending" as const),
			attemptCount: 0,
			createdBy: actor,
			createdAt: now,
		},
	}));
	if (rows.length === 0) return [];
	const [first, ...rest] = rows.map((r) =>
		deps.db.insert(deliveries).values(r.row),
	);
	if (!first) return [];
	await deps.db.batch([
		first,
		...rest,
		auditStmt(c, {
			action: "delivery.replayed",
			resourceType: input.resourceType,
			resourceId: input.resourceId,
			reason: input.reason,
			diff: {
				replayed: rows.map((r) => ({
					source_delivery_id: r.source,
					new_delivery_id: r.row.id,
				})),
				skipped: input.skipped,
			},
		}),
	]);
	const pending = rows
		.filter((r) => r.row.status === "pending")
		.map((r) => r.row.id);
	const { unsent } = await enqueueThenMark(deps, pending, (chunk) =>
		markQueuedMany(deps, chunk),
	);
	if (unsent.length) {
		c.var.logger.warn("admin.replay_enqueue_failed", { unsent: unsent.length });
	}
	const failed = new Set(unsent);
	return rows.map((r) => ({
		source_delivery_id: r.source,
		new_delivery_id: r.row.id,
		status: r.row.status,
		enqueued: r.row.status === "pending" && !failed.has(r.row.id),
	}));
}
