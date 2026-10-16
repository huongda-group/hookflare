import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
	PERMISSION_TAG,
	requirePermission,
} from "../../src/admin/auth/permission";
import type { AppBindings } from "../../src/app";
import type { Role } from "../../src/core/rbac";

function appAs(role: Role | undefined) {
	const app = new Hono<AppBindings>();
	app.use(async (c, next) => {
		if (role) c.set("actor", { email: "x@example.com", role });
		await next();
	});
	app.get("/x", requirePermission("payload.read"), (c) => c.text("ok"));
	return app;
}

describe("requirePermission", () => {
	it("passes a role that holds the permission", async () => {
		expect((await appAs("operator").request("/x")).status).toBe(200);
	});

	it("returns 403 with the missing permission", async () => {
		const res = await appAs("viewer").request("/x");
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "forbidden",
			required: "payload.read",
		});
	});

	it("fails closed without an actor", async () => {
		expect((await appAs(undefined).request("/x")).status).toBe(403);
	});

	it("tags the handler for the route coverage test", () => {
		expect(requirePermission("audit.read")[PERMISSION_TAG]).toBe("audit.read");
	});
});
