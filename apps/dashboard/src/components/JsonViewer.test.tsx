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

	it("collapses by byte length, not character count", () => {
		// 140k two-byte characters: under 256K chars, over 256 KB.
		const big = JSON.stringify({ blob: { data: "é".repeat(140_000) } });
		expect(big.length).toBeLessThan(256 * 1024);
		render(<JsonViewer text={big} contentType="application/json" />);
		expect(screen.getByRole("button", { name: /blob/ })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	});

	it("flags unsafe integers and shows the exact text in Raw", async () => {
		const text = '{"id":12345678901234567890,"note":"99999999999999999999"}';
		render(<JsonViewer text={text} contentType="application/json" />);
		expect(
			screen.getByText(/large numbers may be rounded in tree view/i),
		).toBeInTheDocument();
		expect(screen.queryByText(text)).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Raw" }));
		expect(screen.getByText(text)).toBeInTheDocument();
		expect(
			screen.queryByRole("list", { name: "JSON" }),
		).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Tree" }));
		expect(screen.getByRole("list", { name: "JSON" })).toBeInTheDocument();
	});

	it("does not flag safe integers or big numbers inside strings", () => {
		render(
			<JsonViewer
				text={`{"n":9007199254740991,"s":"12345678901234567890","f":1.5e300,"d":0.12345678901234567890}`}
				contentType="application/json"
			/>,
		);
		expect(
			screen.queryByText(/large numbers may be rounded/i),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Raw" })).toBeInTheDocument();
	});

	it("explains malformed JSON and falls back to text", () => {
		render(<JsonViewer text="{broken" contentType="application/json" />);
		expect(screen.getByText(/not valid JSON/i)).toBeInTheDocument();
		expect(screen.getByText("{broken")).toBeInTheDocument();
	});

	it("bounds trees above 256 KB with a notice and collapsed nodes", () => {
		const big = JSON.stringify({ blob: { data: "x".repeat(300_000) } });
		render(<JsonViewer text={big} contentType="application/json" />);
		expect(screen.getByText(/large payload/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /blob/ })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	});
});
