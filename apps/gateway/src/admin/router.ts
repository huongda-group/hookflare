import { Hono } from "hono";
import type { AppBindings } from "../app";
import { accessMiddleware } from "./auth/access";
import { destinationRoutes } from "./routes/destinations";
import { eventRoutes } from "./routes/events";
import { projectRoutes } from "./routes/projects";
import { sourceRoutes } from "./routes/sources";

/** /api/admin/v1 — everything behind Access + the bootstrap admin list. */
export function adminRoutes(options: { accessFetch?: typeof fetch } = {}) {
	const routes = new Hono<AppBindings>();
	routes.use("*", accessMiddleware({ fetch: options.accessFetch }));
	routes.route("/projects", projectRoutes());
	routes.route("/destinations", destinationRoutes());
	routes.route("/sources", sourceRoutes());
	routes.route("/events", eventRoutes());
	return routes;
}
