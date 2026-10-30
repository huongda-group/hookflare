import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { PasswordField } from "./PasswordField";

describe("PasswordField", () => {
	it("renders masked by default with its label associated", () => {
		render(
			<PasswordField
				id="pw"
				label="Password"
				autoComplete="new-password"
				placeholder="secret"
			/>,
		);
		const input = screen.getByLabelText("Password");
		expect(input).toHaveAttribute("type", "password");
		expect(input).toHaveAttribute("autoComplete", "new-password");
	});

	it("toggles visibility with correct accessible names and preserves the value", async () => {
		const user = userEvent.setup();
		render(
			<PasswordField
				id="pw"
				label="Password"
				autoComplete="new-password"
				defaultValue="correct-horse"
			/>,
		);
		const input = screen.getByLabelText("Password") as HTMLInputElement;
		const show = screen.getByRole("button", { name: "Show Password" });
		await user.click(show);
		expect(input).toHaveAttribute("type", "text");
		expect(input.value).toBe("correct-horse");
		expect(input).toHaveAttribute("autoComplete", "new-password");
		expect(
			screen.getByRole("button", { name: "Hide Password" }),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Hide Password" }));
		expect(input).toHaveAttribute("type", "password");
		expect(input.value).toBe("correct-horse");
		expect(
			screen.getByRole("button", { name: "Show Password" }),
		).toBeInTheDocument();
	});

	it("forwards the input ref (react-hook-form) and keeps it across toggles", async () => {
		const user = userEvent.setup();
		const ref = createRef<HTMLInputElement>();
		render(<PasswordField id="pw" label="Password" ref={ref} />);
		const input = screen.getByLabelText("Password");
		expect(ref.current).toBe(input);
		await user.click(screen.getByRole("button", { name: "Show Password" }));
		expect(ref.current).toBe(input);
	});
});
