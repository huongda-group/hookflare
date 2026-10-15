import { describe, expect, it } from "vitest";
import { can, permissionsOf, ROLE_PERMISSIONS } from "../../src/core/rbac";

describe("rbac", () => {
	it("matches the spec §6.2 table exactly", () => {
		expect(ROLE_PERMISSIONS).toEqual({
			viewer: ["events.read"],
			operator: [
				"events.read",
				"payload.read",
				"deliveries.replay",
				"destinations.operate",
			],
			admin: [
				"events.read",
				"payload.read",
				"deliveries.replay",
				"destinations.operate",
				"config.write",
				"users.manage",
				"audit.read",
			],
		});
	});

	it("answers can() from the table", () => {
		expect(can("viewer", "payload.read")).toBe(false);
		expect(can("operator", "payload.read")).toBe(true);
		expect(can("operator", "config.write")).toBe(false);
		expect(permissionsOf("admin")).toHaveLength(7);
	});
});
