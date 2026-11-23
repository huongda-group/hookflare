import { Hono } from "hono";
import type { AppBindings } from "../app";
import { hasProject } from "../core/db/projects";
import { authMiddleware } from "./auth/session";
import { alertChannelRoutes } from "./routes/alert-channels";
import { alertRoutes } from "./routes/alerts";
import { archiveRoutes } from "./routes/archives";
import { auditLogRoutes } from "./routes/audit-logs";
import { authRoutes } from "./routes/auth";
import { backupRoutes } from "./routes/backups";
import { destinationRoutes } from "./routes/destinations";
import { eventRoutes } from "./routes/events";
import { failureRoutes } from "./routes/failures";
import { meRoutes } from "./routes/me";
import { overviewRoutes } from "./routes/overview";
import { projectRoutes } from "./routes/projects";
import { settingsRoutes } from "./routes/settings";
import { sourceRoutes } from "./routes/sources";
import { userRoutes } from "./routes/users";

export const ADMIN_API_PREFIX = "/api/admin/v1";

export function adminRoutes() {
	const routes = new Hono<AppBindings>();
	routes.route("/auth", authRoutes());
	routes.use("*", authMiddleware());
	routes.use("*", async (c, next) => {
		const { path, method } = c.req;
		if (
			(path === `${ADMIN_API_PREFIX}/me` && method === "GET") ||
			(path === `${ADMIN_API_PREFIX}/projects` &&
				(method === "GET" || method === "POST"))
		) {
			return next();
		}
		if (!(await hasProject(c.var.deps.db))) {
			return c.json({ error: "project_required" }, 409);
		}
		await next();
	});
	routes.route("/me", meRoutes());
	routes.route("/overview", overviewRoutes());
	routes.route("/projects", projectRoutes());
	routes.route("/destinations", destinationRoutes());
	routes.route("/sources", sourceRoutes());
	routes.route("/events", eventRoutes());
	routes.route("/failures", failureRoutes());
	routes.route("/alerts", alertRoutes());
	routes.route("/alert-channels", alertChannelRoutes());
	routes.route("/users", userRoutes());
	routes.route("/audit-logs", auditLogRoutes());
	routes.route("/archives", archiveRoutes());
	routes.route("/backups", backupRoutes());
	routes.route("/settings", settingsRoutes());
	return routes;
}
