import { screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { destination, project, T } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

const list = (...d: ReturnType<typeof destination>[]) =>
	HttpResponse.json({ data: d, next_cursor: null });

describe("Destinations tab", () => {
	it("joins stats and shows the policy defaults as placeholders", async () => {
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({ data: [project()], next_cursor: null }),
			),
			http.get(apiUrl("/destinations"), () => list(destination())),
			http.get(apiUrl("/destinations/stats"), () =>
				HttpResponse.json({
					data: [
						{
							destination_id: "dst_1",
							delivered: 98,
							failed: 2,
							success_rate: 0.98,
							last_delivery_at: T,
							last_http_status: 503,
							last_error: "HTTP 503",
						},
					],
				}),
			),
		);
		const { user } = renderApp("/endpoints?tab=destinations");
		const row = (await screen.findByText("Billing API")).closest(
			"tr",
		) as HTMLElement;
		expect(within(row).getByText("98.0%")).toBeInTheDocument();
		expect(within(row).getByText("HTTP 503")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "New destination" }));
		expect(screen.getByLabelText("Max attempts")).toHaveAttribute(
			"placeholder",
			"default: 20",
		);
	});

	it("shows the signing secret once after create", async () => {
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({ data: [project()], next_cursor: null }),
			),
			http.post(apiUrl("/destinations"), () =>
				HttpResponse.json(
					{ ...destination(), signing_secret: "whsec_once" },
					{ status: 201 },
				),
			),
		);
		const { user } = renderApp("/endpoints?tab=destinations");
		await user.click(
			await screen.findByRole("button", { name: "New destination" }),
		);
		await user.click(screen.getByLabelText("Project"));
		await user.click(await screen.findByRole("option", { name: "Payments" }));
		await user.type(screen.getByLabelText("Name"), "Billing API");
		await user.type(
			screen.getByLabelText("URL"),
			"https://billing.example.com/hooks",
		);
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(await screen.findByText("whsec_once")).toBeInTheDocument();
	});

	it("shows unsafe_url from the server on the form", async () => {
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({ data: [project()], next_cursor: null }),
			),
			http.post(apiUrl("/destinations"), () =>
				HttpResponse.json(
					{ error: "unsafe_url", reason: "private_ip" },
					{ status: 422 },
				),
			),
		);
		const { user } = renderApp("/endpoints?tab=destinations");
		await user.click(
			await screen.findByRole("button", { name: "New destination" }),
		);
		await user.click(screen.getByLabelText("Project"));
		await user.click(await screen.findByRole("option", { name: "Payments" }));
		await user.type(screen.getByLabelText("Name"), "Local");
		await user.type(screen.getByLabelText("URL"), "https://10.0.0.1/hooks");
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(
			await screen.findByText("unsafe_url: private_ip"),
		).toBeInTheDocument();
	});

	it("clears a policy override with null when the field is emptied", async () => {
		const sent = vi.fn();
		server.use(
			http.get(apiUrl("/destinations"), () =>
				list(destination({ max_attempts: 5 })),
			),
			http.patch(apiUrl("/destinations/dst_1"), async ({ request }) => {
				sent(await request.json());
				return HttpResponse.json(destination());
			}),
		);
		const { user } = renderApp("/endpoints?tab=destinations");
		const row = (await screen.findByText("Billing API")).closest(
			"tr",
		) as HTMLElement;
		await user.click(within(row).getByRole("button", { name: "Actions" }));
		await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
		await user.clear(screen.getByLabelText("Max attempts"));
		await user.click(screen.getByRole("button", { name: "Save" }));
		await vi.waitFor(() =>
			expect(sent).toHaveBeenCalledWith(
				expect.objectContaining({ max_attempts: null }),
			),
		);
	});

	it("shows operator actions to operators and hides Rotate", async () => {
		server.use(http.get(apiUrl("/destinations"), () => list(destination())));
		const { user } = renderApp("/endpoints?tab=destinations", {
			role: "operator",
		});
		const row = (await screen.findByText("Billing API")).closest(
			"tr",
		) as HTMLElement;
		await user.click(within(row).getByRole("button", { name: "Actions" }));
		expect(
			await screen.findByRole("menuitem", { name: "Pause" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: "Send test" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("menuitem", { name: "Rotate secret" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("menuitem", { name: "Edit" }),
		).not.toBeInTheDocument();
	});

	it("hides the Actions menu from viewers", async () => {
		server.use(http.get(apiUrl("/destinations"), () => list(destination())));
		renderApp("/endpoints?tab=destinations", { role: "viewer" });
		const row = (await screen.findByText("Billing API")).closest(
			"tr",
		) as HTMLElement;
		expect(
			within(row).queryByRole("button", { name: "Actions" }),
		).not.toBeInTheDocument();
	});

	it("links a destination row to its detail page", async () => {
		server.use(
			http.get(apiUrl("/destinations"), () => list(destination())),
			http.get(apiUrl("/destinations/dst_1"), () =>
				HttpResponse.json(destination()),
			),
		);
		const { user, router } = renderApp("/endpoints?tab=destinations");
		await user.click(await screen.findByRole("link", { name: "Billing API" }));
		expect(router.state.location.pathname).toBe(
			"/endpoints/destinations/dst_1",
		);
		expect(
			await screen.findByRole("heading", { name: "Billing API" }),
		).toBeInTheDocument();
	});
});
