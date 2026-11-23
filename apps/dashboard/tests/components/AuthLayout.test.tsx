import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { focusFirstInvalidField } from "@/components/AuthLayout";

describe("focusFirstInvalidField", () => {
	const ids = { username: "u", password: "p" };
	const renderFields = () =>
		render(
			<>
				<label htmlFor="u">Username</label>
				<input id="u" />
				<label htmlFor="p">Password</label>
				<input id="p" />
			</>,
		);

	it("focuses the first invalid field in form order", () => {
		renderFields();
		focusFirstInvalidField(ids, (name) => name !== "username");
		expect(screen.getByLabelText("Password")).toHaveFocus();
		focusFirstInvalidField(ids, () => true);
		expect(screen.getByLabelText("Username")).toHaveFocus();
	});

	it("leaves focus alone when nothing is invalid", () => {
		renderFields();
		screen.getByLabelText("Password").focus();
		focusFirstInvalidField(ids, () => false);
		expect(screen.getByLabelText("Password")).toHaveFocus();
	});
});
