import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { project } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

describe("Projects", () => {
	it("hides Create from viewers", async () => {
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({ data: [project()], next_cursor: null }),
			),
		);
		renderApp("/projects", { role: "viewer" });
		expect(await screen.findByText("Payments")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "New project" }),
		).not.toBeInTheDocument();
	});

	it("validates with the shared schema before calling the API", async () => {
		let called = false;
		server.use(
			http.post(apiUrl("/projects"), () => {
				called = true;
				return HttpResponse.json(project(), { status: 201 });
			}),
		);
		const { user } = renderApp("/projects");
		await user.click(
			await screen.findByRole("button", { name: "New project" }),
		);
		await user.type(screen.getByLabelText("Name"), "Billing");
		await user.type(screen.getByLabelText("Slug"), "Bad Slug!");
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(
			await screen.findByText(/slug/i, { selector: "[data-field-error]" }),
		).toBeInTheDocument();
		expect(called).toBe(false);
	});

	it("maps a server error onto the form", async () => {
		server.use(
			http.post(apiUrl("/projects"), () =>
				HttpResponse.json({ error: "slug_taken" }, { status: 409 }),
			),
		);
		const { user } = renderApp("/projects");
		await user.click(
			await screen.findByRole("button", { name: "New project" }),
		);
		await user.type(screen.getByLabelText("Name"), "Billing");
		await user.type(screen.getByLabelText("Slug"), "billing");
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(await screen.findByText("slug_taken")).toBeInTheDocument();
	});

	it("creates a project and refreshes the list", async () => {
		let created = false;
		server.use(
			http.post(apiUrl("/projects"), async ({ request }) => {
				created = true;
				return HttpResponse.json(project((await request.json()) as object), {
					status: 201,
				});
			}),
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({
					data: created ? [project({ name: "Billing" })] : [],
					next_cursor: null,
				}),
			),
		);
		const { user } = renderApp("/projects");
		await user.click(
			await screen.findByRole("button", { name: "New project" }),
		);
		await user.type(screen.getByLabelText("Name"), "Billing");
		await user.type(screen.getByLabelText("Slug"), "billing");
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() =>
			expect(screen.getByText("Billing")).toBeInTheDocument(),
		);
	});
});
