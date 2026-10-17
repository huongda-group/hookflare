import type { Me } from "@hookflare/shared";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { permissionsOf } from "../../core/rbac";

/** Any active user; the dashboard uses it to show or hide actions (spec §12). */
export function meRoutes() {
	const routes = new Hono<AppBindings>();
	routes.get("/", (c) => {
		const actor = c.var.actor;
		if (!actor) return c.json({ error: "forbidden" }, 403);
		return c.json({
			username: actor.email,
			role: actor.role,
			permissions: permissionsOf(actor.role),
		} satisfies Me);
	});
	return routes;
}
