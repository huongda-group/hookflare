import { sql } from "drizzle-orm";
import type { Db } from "../deps";
import { auditLogs } from "./db/schema";
import { newId } from "./ids";

export type AuditAction =
	| "project.created"
	| "project.updated"
	| "source.created"
	| "source.updated"
	| "source.secret_rotated"
	| "destination.created"
	| "destination.updated"
	| "destination.paused"
	| "destination.resumed"
	| "destination.tested"
	| "destination.secret_rotated"
	| "delivery.replayed"
	| "event.payload_viewed"
	| "user.created"
	| "user.role_changed"
	| "user.disabled"
	| "user.enabled"
	| "settings.updated"
	| "alert_channel.created"
	| "alert_channel.updated"
	| "alert_channel.deleted"
	| "alert_channel.tested"
	| "archive.downloaded"
	| "archive.run_started"
	| "backup.run";

const SENSITIVE_KEY = /secret|token|password/i;

/** Destination URLs may carry credentials in the path or query (spec §7). */
function originOf(value: string): string {
	try {
		return new URL(value).origin;
	} catch {
		return "[invalid url]";
	}
}

/** Spec §7: drops sensitive keys at any depth and keeps only the origin of `url`. */
export function redactDiff(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactDiff);
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(value)) {
		if (SENSITIVE_KEY.test(key)) continue;
		out[key] =
			key === "url" && typeof v === "string" ? originOf(v) : redactDiff(v);
	}
	return out;
}

export type AuditEntry = {
	actor: string;
	action: AuditAction;
	resourceType: string;
	resourceId: string | null;
	reason?: string | null;
	diff?: Record<string, unknown>;
	at: number;
};

/** Unexecuted: put it in the same db.batch as the mutation (M3-7). */
export function auditInsert(db: Db, e: AuditEntry) {
	return db.insert(auditLogs).values({
		id: newId("aud", e.at),
		actor: e.actor,
		action: e.action,
		resourceType: e.resourceType,
		resourceId: e.resourceId,
		reason: e.reason ?? null,
		diffJson:
			e.diff === undefined
				? null
				: (redactDiff(e.diff) as Record<string, unknown>),
		at: e.at,
	});
}

/**
 * For a conditional UPDATE in the same db.batch: the audit row is written
 * only if the statement right before it changed a row. D1 runs a batch on
 * one connection in order, so changes() refers to that statement.
 */
export function auditInsertIfChanged(db: Db, e: AuditEntry) {
	const diff = e.diff === undefined ? null : JSON.stringify(redactDiff(e.diff));
	return db.insert(auditLogs).select(
		db
			.select({
				id: sql<string>`${newId("aud", e.at)}`.as("id"),
				actor: sql<string>`${e.actor}`.as("actor"),
				action: sql<string>`${e.action}`.as("action"),
				resourceType: sql<string>`${e.resourceType}`.as("resource_type"),
				resourceId: sql<string | null>`${e.resourceId}`.as("resource_id"),
				reason: sql<string | null>`${e.reason ?? null}`.as("reason"),
				diffJson: sql<string | null>`${diff}`.as("diff_json"),
				at: sql<number>`${e.at}`.as("at"),
			})
			.from(sql`(SELECT 1)`)
			.where(sql`changes() > 0`),
	);
}
