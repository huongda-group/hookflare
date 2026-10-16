import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { JsonViewer } from "./JsonViewer";

describe("JsonViewer", () => {
	it("renders JSON as a collapsible tree", async () => {
		render(
			<JsonViewer
				text='{"order":{"id":"o_1","items":[1,2]}}'
				contentType="application/json"
			/>,
		);
		expect(screen.getByRole("list", { name: "JSON" })).toBeInTheDocument();
		expect(screen.getByText('"o_1"')).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /order/ }));
		expect(screen.queryByText('"o_1"')).not.toBeInTheDocument();
	});

	it("never interprets markup in values", () => {
		render(
			<JsonViewer
				text='{"x":"<img src=x onerror=alert(1)>"}'
				contentType="application/json"
			/>,
		);
		expect(document.querySelector("img")).toBeNull();
		expect(
			screen.getByText('"<img src=x onerror=alert(1)>"'),
		).toBeInTheDocument();
	});

	it("shows non-JSON as plain text with a download button", () => {
		render(
			<JsonViewer
				text="a=1&b=2"
				contentType="application/x-www-form-urlencoded"
			/>,
		);
		expect(
			screen.queryByRole("list", { name: "JSON" }),
		).not.toBeInTheDocument();
		expect(screen.getByText("a=1&b=2")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Download" }),
		).toBeInTheDocument();
	});

	it("falls back to text when a JSON content type does not parse", () => {
		render(<JsonViewer text="{broken" contentType="application/json" />);
		expect(screen.getByText("{broken")).toBeInTheDocument();
	});

	it("starts collapsed at depth 1 above 256 KB", () => {
		const big = JSON.stringify({ blob: { data: "x".repeat(300_000) } });
		render(<JsonViewer text={big} contentType="application/json" />);
		expect(screen.getByRole("button", { name: /blob/ })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	});
});
