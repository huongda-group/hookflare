import { and, desc, eq, gte, lt, lte, or, type SQL } from "drizzle-orm";
import type { Db } from "../../deps";
import { type AuditLogRow, auditLogs } from "./schema";

export type AuditFilter = {
	actorEmail?: string;
	resourceType?: string;
	resourceId?: string;
	action?: string;
	from?: number;
	to?: number;
	after?: { at: number; id: string };
	limit: number;
};

export async function searchAuditLogs(
	db: Db,
	f: AuditFilter,
): Promise<AuditLogRow[]> {
	const a = auditLogs;
	const where: (SQL | undefined)[] = [
		f.actorEmail ? eq(a.actorEmail, f.actorEmail) : undefined,
		f.resourceType ? eq(a.resourceType, f.resourceType) : undefined,
		f.resourceId ? eq(a.resourceId, f.resourceId) : undefined,
		f.action ? eq(a.action, f.action) : undefined,
		f.from !== undefined ? gte(a.at, f.from) : undefined,
		f.to !== undefined ? lte(a.at, f.to) : undefined,
		f.after
			? or(
					lt(a.at, f.after.at),
					and(eq(a.at, f.after.at), lt(a.id, f.after.id)),
				)
			: undefined,
	];
	return db
		.select()
		.from(a)
		.where(and(...where))
		.orderBy(desc(a.at), desc(a.id))
		.limit(f.limit + 1)
		.all();
}
