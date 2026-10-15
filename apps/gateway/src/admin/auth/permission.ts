import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../../app";
import { can, type Permission } from "../../core/rbac";

/** Marks guarded handlers so a test can prove every route declares one. */
export const PERMISSION_TAG: unique symbol = Symbol("permission");

export function requirePermission(
	permission: Permission,
): MiddlewareHandler<AppBindings> & { [PERMISSION_TAG]: Permission } {
	const handler: MiddlewareHandler<AppBindings> = async (c, next) => {
		const actor = c.var.actor;
		if (!actor || !can(actor.role, permission)) {
			return c.json({ error: "forbidden", required: permission }, 403);
		}
		await next();
	};
	return Object.assign(handler, { [PERMISSION_TAG]: permission });
}
