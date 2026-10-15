import { desc, eq, lt } from "drizzle-orm";
import type { Db } from "../../deps";
import { type ProjectRow, projects } from "./schema";

export async function getProject(
	db: Db,
	id: string,
): Promise<ProjectRow | undefined> {
	return db.select().from(projects).where(eq(projects.id, id)).get();
}

/** Returns up to limit + 1 rows so the caller can tell whether a next page exists. */
export async function listProjects(
	db: Db,
	q: { limit: number; cursor?: string },
): Promise<ProjectRow[]> {
	return db
		.select()
		.from(projects)
		.where(q.cursor ? lt(projects.id, q.cursor) : undefined)
		.orderBy(desc(projects.id))
		.limit(q.limit + 1)
		.all();
}
