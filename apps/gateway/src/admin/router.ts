import { Hono } from "hono";
import type { AppBindings } from "../app";
import { accessMiddleware } from "./auth/access";

/** /api/admin/v1 — everything behind Access + the bootstrap admin list. */
export function adminRoutes(options: { accessFetch?: typeof fetch } = {}) {
	const routes = new Hono<AppBindings>();
	routes.use("*", accessMiddleware({ fetch: options.accessFetch }));
	// Placeholder until Task 10 mounts the projects resource.
	routes.get("/projects", (c) => c.json({ data: [], next_cursor: null }));
	return routes;
}
