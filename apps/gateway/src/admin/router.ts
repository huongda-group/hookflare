import { Hono } from "hono";
import type { AppBindings } from "../app";
import { accessMiddleware } from "./auth/access";
import { destinationRoutes } from "./routes/destinations";
import { eventRoutes } from "./routes/events";
import { meRoutes } from "./routes/me";
import { projectRoutes } from "./routes/projects";
import { sourceRoutes } from "./routes/sources";

/** /api/admin/v1 — Access, then a users row, then a per-route permission. */
export function adminRoutes(options: { accessFetch?: typeof fetch } = {}) {
	const routes = new Hono<AppBindings>();
	routes.use("*", accessMiddleware({ fetch: options.accessFetch }));
	routes.route("/me", meRoutes());
	routes.route("/projects", projectRoutes());
	routes.route("/destinations", destinationRoutes());
	routes.route("/sources", sourceRoutes());
	routes.route("/events", eventRoutes());
	return routes;
}
