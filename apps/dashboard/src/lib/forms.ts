import { flushSync } from "react-dom";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { ApiError } from "./api";

/** Register options for an optional number input: "" means "not set". */
export const optionalNumber = {
	setValueAs: (v: unknown) =>
		v === "" || v === null || v === undefined ? undefined : Number(v),
};
/** For PATCH: "" means "clear the override" (null). */
export const nullableNumber = {
	setValueAs: (v: unknown) =>
		v === "" || v === null || v === undefined ? null : Number(v),
};

export function errorText(err: unknown): string {
	if (!(err instanceof ApiError)) return "Something went wrong.";
	const reason =
		typeof err.body?.reason === "string" ? `: ${err.body.reason}` : "";
	return `${err.code}${reason}`;
}

/** Spec M4-4: server `issues` land on the same fields the client schema uses. */
export function applyServerIssues<T extends FieldValues>(
	form: UseFormReturn<T>,
	err: unknown,
): boolean {
	// Read first: react-hook-form only notifies subscribed formState slices,
	// and this read marks `errors` as subscribed (otherwise setError is dropped).
	// flushSync then makes `formState.errors` readable synchronously, since
	// React 19 no longer flushes setError outside act/event handlers.
	void form.formState.errors;
	if (err instanceof ApiError && err.issues?.length) {
		let mapped = false;
		flushSync(() => {
			for (const issue of err.issues ?? []) {
				if (issue.path) {
					form.setError(issue.path as Path<T>, { message: issue.message });
					mapped = true;
				} else {
					form.setError("root", { message: issue.message });
				}
			}
		});
		return mapped;
	}
	flushSync(() => {
		form.setError("root", { message: errorText(err) });
	});
	return false;
}
