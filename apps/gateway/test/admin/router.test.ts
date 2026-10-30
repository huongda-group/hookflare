import { describe, expect, it } from "vitest";
import { PERMISSION_TAG } from "../../src/admin/auth/permission";
import { adminRoutes } from "../../src/admin/router";

describe("admin router", () => {
	it("declares a permission on every route except /me and the public auth routes", () => {
		const guarded = new Map<string, boolean>();
		for (const r of adminRoutes().routes) {
			if (r.method === "ALL") continue; // middleware (authMiddleware)
			const key = `${r.method} ${r.path.replace(/\/$/, "")}`;
			guarded.set(
				key,
				(guarded.get(key) ?? false) || PERMISSION_TAG in r.handler,
			);
		}
		const unguarded = [...guarded]
			.filter(([key, ok]) => {
				// /auth/* is deliberately public (onboarding, login, logout);
				// /me and /me/password are any-authenticated-user (spec §6.6).
				const path = key.slice(key.indexOf(" ") + 1);
				return (
					!ok &&
					path !== "/me" &&
					!path.startsWith("/me/") &&
					!path.startsWith("/auth")
				);
			})
			.map(([key]) => key);
		expect(unguarded).toEqual([]);
		expect(guarded.size).toBeGreaterThanOrEqual(15);
	});
});
