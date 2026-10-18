import { screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { destination, project, source } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

const base = () => [
	http.get(apiUrl("/projects"), () =>
		HttpResponse.json({ data: [project()], next_cursor: null }),
	),
	http.get(apiUrl("/destinations"), () =>
		HttpResponse.json({ data: [destination()], next_cursor: null }),
	),
];

async function fillBasics(user: ReturnType<typeof renderApp>["user"]) {
	await user.click(await screen.findByRole("button", { name: "New source" }));
	await user.click(screen.getByLabelText("Project"));
	await user.click(await screen.findByRole("option", { name: "Payments" }));
	await user.click(screen.getByLabelText("Destination"));
	await user.click(await screen.findByRole("option", { name: "Billing API" }));
	await user.type(screen.getByLabelText("Name"), "Stripe");
}

describe("Sources tab", () => {
	it("lists sources with a copyable ingress URL", async () => {
		server.use(
			...base(),
			http.get(apiUrl("/sources"), () =>
				HttpResponse.json({ data: [source()], next_cursor: null }),
			),
		);
		renderApp("/endpoints?tab=sources");
		const row = (await screen.findByText("Stripe")).closest(
			"tr",
		) as HTMLElement;
		expect(
			within(row).getByText("https://hooks.example.com/in/src_1"),
		).toBeInTheDocument();
	});

	it("shows HMAC fields only for hmac and sends a discriminated body", async () => {
		const sent = vi.fn();
		server.use(
			...base(),
			http.post(apiUrl("/sources"), async ({ request }) => {
				sent(await request.json());
				return HttpResponse.json(
					{ ...source(), secret: "shh_generated" },
					{ status: 201 },
				);
			}),
		);
		const { user } = renderApp("/endpoints?tab=sources");
		await fillBasics(user);
		expect(screen.queryByLabelText("Signature header")).not.toBeInTheDocument();
		await user.click(screen.getByLabelText("Auth type"));
		await user.click(
			await screen.findByRole("option", { name: "HMAC signature" }),
		);
		await user.type(screen.getByLabelText("Signature header"), "X-Signature");
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(await screen.findByText("shh_generated")).toBeInTheDocument();
		expect(sent).toHaveBeenCalledWith(
			expect.objectContaining({
				auth_type: "hmac",
				auth_config: expect.objectContaining({
					header: "X-Signature",
					algorithm: "sha256",
					encoding: "hex",
				}),
			}),
		);
	});

	it("requires a selector when event ID extraction is on", async () => {
		server.use(...base());
		const { user } = renderApp("/endpoints?tab=sources");
		await fillBasics(user);
		await user.click(screen.getByLabelText("Event ID from"));
		await user.click(await screen.findByRole("option", { name: "JSON path" }));
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(
			await screen.findByText(/selector/i, { selector: "[data-field-error]" }),
		).toBeInTheDocument();
	});

	it("links a source row to its detail page", async () => {
		server.use(
			...base(),
			http.get(apiUrl("/sources"), () =>
				HttpResponse.json({ data: [source()], next_cursor: null }),
			),
			http.get(apiUrl("/sources/src_1"), () => HttpResponse.json(source())),
		);
		const { user, router } = renderApp("/endpoints?tab=sources");
		await user.click(await screen.findByRole("link", { name: "Stripe" }));
		expect(router.state.location.pathname).toBe("/endpoints/sources/src_1");
		expect(
			await screen.findByRole("heading", { name: "Stripe" }),
		).toBeInTheDocument();
	});

	it("names the destination relationship instead of showing a bare ID", async () => {
		server.use(
			...base(),
			http.get(apiUrl("/sources"), () =>
				HttpResponse.json({ data: [source()], next_cursor: null }),
			),
		);
		renderApp("/endpoints?tab=sources");
		const row = (await screen.findByText("Stripe")).closest(
			"tr",
		) as HTMLElement;
		expect(
			await within(row).findByRole("link", { name: "Billing API" }),
		).toHaveAttribute("href", "/endpoints/destinations/dst_1");
	});

	it("offers New source as the empty next step", async () => {
		renderApp("/endpoints?tab=sources");
		await screen.findByText("No sources yet.");
		const table = screen.getByRole("table");
		expect(
			within(table).getByRole("button", { name: "New source" }),
		).toBeInTheDocument();
	});
});
