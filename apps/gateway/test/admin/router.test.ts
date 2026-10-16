import { describe, expect, it } from "vitest";
import { PERMISSION_TAG } from "../../src/admin/auth/permission";
import { adminRoutes } from "../../src/admin/router";

describe("admin router", () => {
	it("declares a permission on every route except /me", () => {
		const guarded = new Map<string, boolean>();
		for (const r of adminRoutes().routes) {
			if (r.method === "ALL") continue; // middleware (Access)
			const key = `${r.method} ${r.path.replace(/\/$/, "")}`;
			guarded.set(
				key,
				(guarded.get(key) ?? false) || PERMISSION_TAG in r.handler,
			);
		}
		const unguarded = [...guarded]
			.filter(([key, ok]) => !ok && key !== "GET /me")
			.map(([key]) => key);
		expect(unguarded).toEqual([]);
		expect(guarded.size).toBeGreaterThanOrEqual(15);
	});
});
