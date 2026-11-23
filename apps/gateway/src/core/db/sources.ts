import { and, desc, eq, lt } from "drizzle-orm";
import type { Db, Deps } from "../../deps";
import { decryptSecret } from "../crypto";
import { aad, activeSecrets } from "../secrets";
import {
	type DestinationRow,
	destinations,
	projects,
	type SourceRow,
	sources,
} from "./schema";

export type SourceBundle = {
	source: SourceRow;
	projectStatus: "active" | "disabled";
	destinationStatus: DestinationRow["status"];
	secret: string | null;
	previousSecret: string | null;
	previousSecretExpiresAt: number | null;
};

export async function loadSourceBundle(
	deps: Deps,
	sourceId: string,
): Promise<SourceBundle | null> {
	const [row] = await deps.db
		.select({
			source: sources,
			projectStatus: projects.status,
			destinationStatus: destinations.status,
		})
		.from(sources)
		.innerJoin(projects, eq(projects.id, sources.projectId))
		.innerJoin(destinations, eq(destinations.id, sources.destinationId))
		.where(eq(sources.id, sourceId))
		.limit(1);
	if (!row) {
		return null;
	}
	const secret = row.source.secretEnc
		? await decryptSecret(deps.env, row.source.secretEnc, aad.source(sourceId))
		: null;
	const { prevEnc } = activeSecrets(
		{
			enc: row.source.secretEnc ?? "",
			prevEnc: row.source.secretPrevEnc,
			prevExpiresAt: row.source.secretPrevExpiresAt,
		},
		deps.now(),
	);
	const previousSecret = prevEnc
		? await decryptSecret(deps.env, prevEnc, aad.sourcePrev(sourceId))
		: null;
	return {
		source: row.source,
		projectStatus: row.projectStatus,
		destinationStatus: row.destinationStatus,
		secret,
		previousSecret,
		previousSecretExpiresAt: previousSecret
			? row.source.secretPrevExpiresAt
			: null,
	};
}

export async function getSource(
	db: Db,
	id: string,
): Promise<SourceRow | undefined> {
	return db.select().from(sources).where(eq(sources.id, id)).get();
}

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
