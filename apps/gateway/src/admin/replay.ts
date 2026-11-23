import { sql } from "drizzle-orm";
import type { Context } from "hono";
import type { AppBindings } from "../app";
import { unmarkEventsStatements } from "../core/db/archive";
import { activeReplays, markQueuedMany } from "../core/db/deliveries";
import { listDestinationStatuses } from "../core/db/destinations";
import { getEventR2Keys } from "../core/db/events";
import { insertReplayIfIdleStmt } from "../core/db/replays";
import { auditLogs } from "../core/db/schema";
import { enqueueThenMark } from "../core/enqueue";
import { newId } from "../core/ids";
import type { Deps } from "../deps";

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
 * The `delivery.replayed` audit row, built in SQL after the conditional
 * inserts of the same batch: it lists only the replays that were created
 * (their fresh IDs exist), adds the lost ones to `skipped` as
 * `replay_in_progress`, and is written only if at least one was created.
 */
function replayAuditStmt(
	deps: Deps,
	a: {
		actor: string;
		at: number;
		resourceType: "event" | "delivery";
		resourceId: string | null;
		reason: string;
		candidates: { s: string; n: string }[];
		skipped: Skip[];
	},
) {
	const cand = JSON.stringify(a.candidates);
	const created = sql`EXISTS (SELECT 1 FROM deliveries d WHERE d.id = json_extract(c.value, '$.n'))`;
	const diff = sql`json_object(
		'replayed', (SELECT json_group_array(json_object('source_delivery_id', json_extract(c.value, '$.s'), 'new_delivery_id', json_extract(c.value, '$.n'))) FROM json_each(${cand}) c WHERE ${created}),
		'skipped', (SELECT json_group_array(json(v)) FROM (
			SELECT 0 AS g, k.key AS o, k.value AS v FROM json_each(${JSON.stringify(a.skipped)}) k
			UNION ALL
			SELECT 1, c.key, json_object('delivery_id', json_extract(c.value, '$.s'), 'reason', 'replay_in_progress') FROM json_each(${cand}) c WHERE NOT ${created}
			ORDER BY g, o
		))
	)`;
	return deps.db.insert(auditLogs).select(
		deps.db
			.select({
				id: sql<string>`${newId("aud", a.at)}`.as("id"),
				actor: sql<string>`${a.actor}`.as("actor"),
				action: sql<string>`'delivery.replayed'`.as("action"),
				resourceType: sql<string>`${a.resourceType}`.as("resource_type"),
				resourceId: sql<string | null>`${a.resourceId}`.as("resource_id"),
				reason: sql<string>`${a.reason}`.as("reason"),
				diffJson: sql<string>`${diff}`.as("diff_json"),
				at: sql<number>`${a.at}`.as("at"),
			})
			.from(sql`(SELECT 1)`)
			.where(sql`EXISTS (SELECT 1 FROM json_each(${cand}) c WHERE ${created})`),
	);
}

/**
 * Spec §9.3: one batch of conditional replay inserts plus one audit row, then
 * enqueue the created non-paused ones. A replay that lost a race to a
 * concurrent one (precheck passed, insert did not) is returned in `lost` with
 * the precheck's `replay_in_progress` reason. A failed send leaves rows
 * pending for the reconciler.
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
	const actor =
		c.var.actor?.username ??
		/* istanbul ignore next -- @preserve unreachable: every caller is a requirePermission-guarded route, so an actor is set */ "";
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
			enqueuedAt: null,
			nextAttemptAt: null,
			leaseUntil: null,
			lastHttpStatus: null,
			lastError: null,
			completedAt: null,
			createdBy: actor,
			createdAt: now,
		},
	}));
	const lost: Skip[] = [];
	if (rows.length === 0) return { replayed: [], lost };
	const [first, ...rest] = rows.map((r) =>
		insertReplayIfIdleStmt(deps.db, r.row),
	);
	/* istanbul ignore next -- @preserve unreachable: rows is non-empty here (checked above); only narrows the type */
	if (!first) return { replayed: [], lost };
	const results = await deps.db.batch([
		first,
		...rest,
		...unmarkEventsStatements(
			deps.db,
			input.ready.map((t) => t.eventId),
		),
		replayAuditStmt(deps, {
			actor,
			at: now,
			resourceType: input.resourceType,
			resourceId: input.resourceId,
			reason: input.reason,
			candidates: rows.map((r) => ({ s: r.source, n: r.row.id })),
			skipped: input.skipped,
		}),
	]);
	const created = rows.filter((r, i) => {
		const inserted = (results[i] as { id: string }[]).length > 0;
		if (!inserted) {
			lost.push({ delivery_id: r.source, reason: "replay_in_progress" });
		}
		return inserted;
	});
	const pending = created
		.filter((r) => r.row.status === "pending")
		.map((r) => r.row.id);
	const { unsent } = await enqueueThenMark(deps, pending, (chunk) =>
		markQueuedMany(deps, chunk),
	);
	if (unsent.length) {
		c.var.logger.warn("admin.replay_enqueue_failed", { unsent: unsent.length });
	}
	const failed = new Set(unsent);
	return {
		replayed: created.map((r) => ({
			source_delivery_id: r.source,
			new_delivery_id: r.row.id,
			status: r.row.status,
			enqueued: r.row.status === "pending" && !failed.has(r.row.id),
		})),
		lost,
	};
}
