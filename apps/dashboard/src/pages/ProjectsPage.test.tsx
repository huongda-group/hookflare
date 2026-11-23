import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { project } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

describe("Projects", () => {
	it("keeps management independent until following a project-scoped link", async () => {
		const a = project({ id: "prj_a", name: "Payments" });
		const b = project({ id: "prj_b", name: "Shipping" });
		localStorage.setItem("hookflare.activeProjectId", a.id);
		server.use(
			http.get(apiUrl("/projects"), ({ request }) => {
				expect(new URL(request.url).searchParams.has("project_id")).toBe(false);
				return HttpResponse.json({ data: [a, b], next_cursor: null });
			}),
			http.get(apiUrl("/projects/prj_b"), () => HttpResponse.json(b)),
			http.get(apiUrl("/overview"), () => HttpResponse.error()),
		);
		const { user, router } = renderApp("/projects");
		try {
			expect(
				await screen.findByRole("link", { name: "Payments" }),
			).toBeVisible();
			await user.click(screen.getByRole("link", { name: "Shipping" }));
			const picker = await screen.findByRole("combobox", {
				name: "Active project",
			});
			expect(picker).toHaveTextContent(a.name);
			await user.click(
				within(
					await screen.findByRole("navigation", { name: "Project resources" }),
				).getByRole("link", { name: "Events" }),
			);
			await waitFor(() =>
				expect(router.state.location.search).toMatchObject({
					project_id: b.id,
				}),
			);
			expect(picker).toHaveTextContent(b.name);
		} finally {
			localStorage.removeItem("hookflare.activeProjectId");
		}
	});
	it("hides Create from viewers", async () => {
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({ data: [project()], next_cursor: null }),
			),
		);
		renderApp("/projects", { role: "viewer" });
		expect(
			await screen.findByRole("link", { name: "Payments" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "New project" }),
		).not.toBeInTheDocument();
	});

	it("shows the name field without a redundant project heading when creating", async () => {
		const { user } = renderApp("/projects");
		await user.click(
			await screen.findByRole("button", { name: "New project" }),
		);
		const dialog = within(screen.getByRole("dialog", { name: "New project" }));
		expect(dialog.getByRole("textbox", { name: "Name" })).toBeVisible();
		expect(
			dialog.queryByRole("heading", { name: "Project" }),
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
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(
			await screen.findByText(/too small/i, { selector: "[data-field-error]" }),
		).toBeInTheDocument();
		expect(called).toBe(false);
	});

	it("maps a server error onto the form", async () => {
		server.use(
			http.post(apiUrl("/projects"), () =>
				HttpResponse.json({ error: "internal_error" }, { status: 500 }),
			),
		);
		const { user } = renderApp("/projects");
		await user.click(
			await screen.findByRole("button", { name: "New project" }),
		);
		await user.type(screen.getByLabelText("Name"), "Billing");
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(await screen.findByText("internal_error")).toBeInTheDocument();
	});

	it("creates a project with only its name and refreshes the list", async () => {
		let created = false;
		let submitted: unknown;
		server.use(
			http.post(apiUrl("/projects"), async ({ request }) => {
				submitted = await request.json();
				created = true;
				return HttpResponse.json(project({ name: "Billing" }), {
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
		expect(screen.queryByLabelText("Slug")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() =>
			expect(screen.getByRole("link", { name: "Billing" })).toBeInTheDocument(),
		);
		expect(submitted).toEqual({ name: "Billing" });
	});

	it("shows the current name when Edit is reopened after a rename", async () => {
		let current = project();
		server.use(
			http.get(apiUrl("/projects/prj_1"), () => HttpResponse.json(current)),
			http.patch(apiUrl("/projects/prj_1"), async ({ request }) => {
				current = project((await request.json()) as object);
				return HttpResponse.json(current);
			}),
			http.get(apiUrl("/overview"), () => HttpResponse.error()),
		);
		const { user } = renderApp("/projects/prj_1");
		await user.click(await screen.findByRole("button", { name: "Edit" }));
		const name = screen.getByLabelText("Name");
		expect(name).toHaveValue("Payments");
		await user.clear(name);
		await user.type(name, "Billing");
		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(
			await screen.findByRole("heading", { name: "Billing" }),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.queryByLabelText("Name")).not.toBeInTheDocument(),
		);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		expect(screen.getByLabelText("Name")).toHaveValue("Billing");
	});

	it("links each project to its scoped detail page", async () => {
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({ data: [project()], next_cursor: null }),
			),
		);
		renderApp("/projects");
		const link = await screen.findByRole("link", { name: "Payments" });
		expect(link).toHaveAttribute("href", "/projects/prj_1");
		expect(
			within(screen.getByRole("row", { name: /Payments/ })).getByText("prj_1"),
		).toBeVisible();
	});

	it("offers New project as the empty next step when creation is allowed", async () => {
		renderApp("/projects");
		const table = await screen.findByRole("table");
		expect(
			within(table).getByRole("button", { name: "New project" }),
		).toBeInTheDocument();
	});

	it("offers no empty next step to viewers", async () => {
		renderApp("/projects", { role: "viewer" });
		const table = await screen.findByRole("table");
		expect(
			within(table).queryByRole("button", { name: "New project" }),
		).not.toBeInTheDocument();
	});

	it("blocks an accidental cancel and keeps the edits", async () => {
		const { user } = renderApp("/projects");
		await user.click(
			await screen.findByRole("button", { name: "New project" }),
		);
		await user.type(screen.getByLabelText("Name"), "Billing");
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(
			await screen.findByRole("heading", { name: /discard/i }),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Keep editing" }));
		expect(screen.getByLabelText("Name")).toHaveValue("Billing");
		expect(
			screen.queryByRole("heading", { name: /discard/i }),
		).not.toBeInTheDocument();
	});
});
