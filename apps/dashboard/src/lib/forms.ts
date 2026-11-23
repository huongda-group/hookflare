import { flushSync } from "react-dom";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { ApiError } from "./api";

export const optionalNumber = {
	setValueAs: (v: unknown) =>
		v === "" || v === null || v === undefined ? undefined : Number(v),
};
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

export function applyServerIssues<T extends FieldValues>(
	form: UseFormReturn<T>,
	err: unknown,
): boolean {
	void form.formState.errors;
	if (err instanceof ApiError && err.issues?.length) {
		let mapped = false;
		flushSync(() => {
			for (const issue of err.issues ??
				/* istanbul ignore next -- @preserve */ []) {
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
