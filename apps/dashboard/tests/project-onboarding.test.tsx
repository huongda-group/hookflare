import { focusManager } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { project } from "./helpers/fixtures";
import { renderApp } from "./helpers/render";
import { apiUrl, meFor, server } from "./helpers/server";

describe("first project onboarding", () => {
	it.each(["/login?next=%2Fevents", "/login?next=%2Flogin", "/setup"])(
		"opens Projects after completing %s when no project exists",
		async (path) => {
			let setupRequired = path === "/setup";
			const blockedRequests: string[] = [];
			server.use(
				...["/overview", "/events"].map((endpoint) =>
					http.get(apiUrl(endpoint), () => {
						blockedRequests.push(endpoint);
						return HttpResponse.json(
							{ error: "project_required" },
							{ status: 409 },
						);
					}),
				),
				http.get(apiUrl("/auth/state"), () =>
					HttpResponse.json({
						setup_required: setupRequired,
						turnstile_site_key: null,
					}),
				),
				http.post(apiUrl("/auth/setup"), () => {
					setupRequired = false;
					return HttpResponse.json(
						{ username: "admin", role: "admin" },
						{ status: 201 },
					);
				}),
				http.get(apiUrl("/me"), () =>
					HttpResponse.json({ ...meFor("admin"), project_required: true }),
				),
			);
			const { router, user } = renderApp(path);
			await user.type(await screen.findByLabelText("Username"), "admin");
			await user.type(screen.getByLabelText("Password"), "correct-horse");
			if (setupRequired) {
				await user.type(
					screen.getByLabelText("Confirm password"),
					"correct-horse",
				);
				await user.click(
					screen.getByRole("button", { name: "Create admin account" }),
				);
			} else {
				await user.click(screen.getByRole("button", { name: "Sign in" }));
			}
			expect(
				await screen.findByRole("heading", { name: "Projects" }),
			).toBeInTheDocument();
			expect(router.state.location.pathname).toBe("/projects");
			expect(blockedRequests).toEqual([]);
		},
	);

	it("blocks direct navigation and unlocks navigation after the first project is created", async () => {
		let created = false;
		server.use(
			http.get(apiUrl("/me"), () =>
				HttpResponse.json({ ...meFor("admin"), project_required: !created }),
			),
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({
					data: created ? [project()] : [],
					next_cursor: null,
				}),
			),
			http.post(apiUrl("/projects"), () => {
				created = true;
				return HttpResponse.json(project(), { status: 201 });
			}),
		);
		const { router, user } = renderApp("/events");
		expect(
			await screen.findByRole("heading", { name: "Projects" }),
		).toBeInTheDocument();
		expect(router.state.location.pathname).toBe("/projects");
		expect(
			screen.queryByRole("combobox", { name: "Active project" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "Events" }),
		).not.toBeInTheDocument();

		await user.click(screen.getAllByRole("button", { name: "New project" })[0]);
		const dialog = await screen.findByRole("dialog", { name: "New project" });
		await user.type(within(dialog).getByLabelText("Name"), "Payments");
		await user.click(within(dialog).getByRole("button", { name: "Create" }));
		expect(
			await screen.findByRole("combobox", { name: "Active project" }),
		).toHaveTextContent("Payments");
		await user.click(await screen.findByRole("link", { name: "Events" }));
		await waitFor(() => expect(router.state.location.pathname).toBe("/events"));
	});

	it("tells a viewer who cannot create a project to contact an admin", async () => {
		server.use(
			http.get(apiUrl("/me"), () =>
				HttpResponse.json({ ...meFor("viewer"), project_required: true }),
			),
		);
		const { user } = renderApp("/settings");
		expect(await screen.findByText(/ask an admin/i)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "New project" }),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /^Account:/ }));
		expect(
			screen.getByRole("menuitem", { name: "Log out" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("menuitem", { name: "Change password" }),
		).not.toBeInTheDocument();
	});

	it("unlocks an open viewer tab on focus after another admin creates a project", async () => {
		let created = false;
		server.use(
			http.get(apiUrl("/me"), () =>
				HttpResponse.json({ ...meFor("viewer"), project_required: !created }),
			),
		);
		renderApp("/projects");
		expect(await screen.findByText(/ask an admin/i)).toBeInTheDocument();
		try {
			act(() => focusManager.setFocused(false));
			created = true;
			act(() => focusManager.setFocused(true));
			expect(
				await screen.findByRole("link", { name: "Events" }),
			).toBeInTheDocument();
		} finally {
			act(() => focusManager.setFocused(undefined));
		}
	});
});
