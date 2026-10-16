import { renderHook } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { applyServerIssues, errorText } from "./forms";

describe("applyServerIssues", () => {
	it("maps server issues onto fields, nested paths included", () => {
		const { result } = renderHook(() =>
			useForm({ defaultValues: { slug: "", auth_config: { header: "" } } }),
		);
		const mapped = applyServerIssues(
			result.current,
			new ApiError(400, "invalid_request", [
				{ path: "slug", code: "invalid", message: "Slug taken" },
				{ path: "auth_config.header", code: "invalid", message: "Bad header" },
			]),
		);
		expect(mapped).toBe(true);
		expect(result.current.getFieldState("slug").error?.message).toBe(
			"Slug taken",
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
		expect(errorText(new ApiError(409, "slug_taken"))).toBe("slug_taken");
	});
});
