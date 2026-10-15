import { and, desc, eq, lt } from "drizzle-orm";
import type { Db, Deps } from "../../deps";
import { decryptSecret } from "../crypto";
import { projects, type SourceRow, sources } from "./schema";

export type SourceBundle = {
	source: SourceRow;
	projectStatus: "active" | "disabled";
	/** Decrypted source secret; null for auth_type none. */
	secret: string | null;
};

/** null when the source does not exist. D1 and decrypt errors propagate. */
export async function loadSourceBundle(
	deps: Deps,
	sourceId: string,
): Promise<SourceBundle | null> {
	const [row] = await deps.db
		.select({ source: sources, projectStatus: projects.status })
		.from(sources)
		.innerJoin(projects, eq(projects.id, sources.projectId))
		.where(eq(sources.id, sourceId))
		.limit(1);
	if (!row) {
		return null;
	}
	const secret = row.source.secretEnc
		? await decryptSecret(
				deps.env,
				row.source.secretEnc,
				`sources.secret_enc:${sourceId}`,
			)
		: null;
	return { source: row.source, projectStatus: row.projectStatus, secret };
}

export async function getSource(
	db: Db,
	id: string,
): Promise<SourceRow | undefined> {
	return db.select().from(sources).where(eq(sources.id, id)).get();
}

/** Returns up to limit + 1 rows, id descending. */
export async function listSources(
	db: Db,
	q: { limit: number; cursor?: string; projectId?: string },
): Promise<SourceRow[]> {
	return db
		.select()
		.from(sources)
		.where(
			and(
				q.cursor ? lt(sources.id, q.cursor) : undefined,
				q.projectId ? eq(sources.projectId, q.projectId) : undefined,
			),
		)
		.orderBy(desc(sources.id))
		.limit(q.limit + 1)
		.all();
}
