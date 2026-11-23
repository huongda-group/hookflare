import { renderHook } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { applyServerIssues, errorText } from "@/lib/forms";

describe("applyServerIssues", () => {
	it("maps server issues onto fields, nested paths included", () => {
		const { result } = renderHook(() =>
			useForm({ defaultValues: { name: "", auth_config: { header: "" } } }),
		);
		const mapped = applyServerIssues(
			result.current,
			new ApiError(400, "invalid_request", [
				{ path: "name", code: "invalid", message: "Bad name" },
				{ path: "auth_config.header", code: "invalid", message: "Bad header" },
			]),
		);
		expect(mapped).toBe(true);
		expect(result.current.getFieldState("name").error?.message).toBe(
			"Bad name",
		);
		expect(
			result.current.getFieldState("auth_config.header").error?.message,
		).toBe("Bad header");
	});

	it("puts a pathless issue or another error code on root", () => {
		const { result } = renderHook(() => useForm());
		applyServerIssues(
			result.current,
			new ApiError(422, "unsafe_url", undefined, undefined, {
				reason: "private_ip",
			}),
		);
		expect(result.current.formState.errors.root?.message).toBe(
			"unsafe_url: private_ip",
		);
		expect(errorText(new ApiError(409, "conflict"))).toBe("conflict");
	});
});
