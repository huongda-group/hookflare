import { describe, expect, it } from "vitest";
import { getWriteToast } from "@/lib/write-toast";

describe("getWriteToast", () => {
	it("names a user update that is neither a role nor an enable change", () => {
		expect(getWriteToast("PATCH", "/users/op", { name: "Op" })).toEqual({
			success: "User updated",
			error: "Could not update user",
			queued: false,
		});
		expect(
			getWriteToast("PATCH", "/users/op", { role: "admin" })?.success,
		).toBe("User role updated");
		expect(
			getWriteToast("PATCH", "/users/op", { disabled: true })?.success,
		).toBe("User disabled");
	});

	it("picks the settings section from the patch body, with a generic fallback", () => {
		expect(
			getWriteToast("PATCH", "/settings", { alert_rules: {} })?.success,
		).toBe("Alert rules saved");
		expect(getWriteToast("PATCH", "/settings", {})).toEqual({
			success: "Settings saved",
			error: "Could not save settings",
			queued: false,
		});
		expect(getWriteToast("PATCH", "/settings", null)?.success).toBe(
			"Settings saved",
		);
	});

	it("has no copy for an unknown patch target", () => {
		expect(getWriteToast("PATCH", "/archives/arc_1", {})).toBeUndefined();
		expect(getWriteToast("PUT", "/settings", {})).toBeUndefined();
	});
});
