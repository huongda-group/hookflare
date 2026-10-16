import {
	createProjectRequest,
	listQuery,
	type Page,
	type Project,
	patchProjectRequest,
} from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { isUniqueViolation } from "../../core/db/errors";
import { getProject, listProjects } from "../../core/db/projects";
import { type ProjectRow, projects } from "../../core/db/schema";
import { newId } from "../../core/ids";
import { requirePermission } from "../auth/permission";
import { auditStmt, paginate, readJson, readQuery } from "../http";

export function toProject(row: ProjectRow): Project {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		status: row.status,
		created_at: row.createdAt,
		updated_at: row.updatedAt,
	};
}

export function projectRoutes() {
	const routes = new Hono<AppBindings>();

	routes.post("/", requirePermission("config.write"), async (c) => {
		const body = await readJson(c, createProjectRequest);
		if (!body.ok) return body.response;
		const { reason, ...fields } = body.value;
		const { db, now } = c.var.deps;
		const ts = now();
		const row: ProjectRow = {
			id: newId("prj", ts),
			...fields,
			status: "active",
			createdAt: ts,
			updatedAt: ts,
		};
		try {
			await db.batch([
				db.insert(projects).values(row),
				auditStmt(c, {
					action: "project.created",
					resourceType: "project",
					resourceId: row.id,
					diff: fields,
					reason,
				}),
			]);
		} catch (err) {
			if (isUniqueViolation(err)) return c.json({ error: "conflict" }, 409);
			throw err;
		}
		return c.json(toProject(row), 201);
	});

	routes.get("/", requirePermission("events.read"), async (c) => {
		const q = readQuery(c, listQuery);
		if (!q.ok) return q.response;
		const { rows, nextCursor } = paginate(
			await listProjects(c.var.deps.db, q.value),
			q.value.limit,
		);
		return c.json({
			data: rows.map(toProject),
			next_cursor: nextCursor,
		} satisfies Page<Project>);
	});

	routes.get("/:id", requirePermission("events.read"), async (c) => {
		const row = await getProject(c.var.deps.db, c.req.param("id"));
		return row ? c.json(toProject(row)) : c.json({ error: "not_found" }, 404);
	});

	routes.patch("/:id", requirePermission("config.write"), async (c) => {
		const body = await readJson(c, patchProjectRequest);
		if (!body.ok) return body.response;
		const { reason, ...fields } = body.value;
		const { db, now } = c.var.deps;
		const id = c.req.param("id");
		if (!(await getProject(db, id))) return c.json({ error: "not_found" }, 404);
		const [[row]] = await db.batch([
			db
				.update(projects)
				.set({ ...fields, updatedAt: now() })
				.where(eq(projects.id, id))
				.returning(),
			auditStmt(c, {
				action: "project.updated",
				resourceType: "project",
				resourceId: id,
				diff: fields,
				reason,
			}),
		]);
		return c.json(toProject(row));
	});

	return routes;
}
