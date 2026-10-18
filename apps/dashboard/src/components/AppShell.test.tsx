import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render";
import { apiUrl, meFor, server } from "@/test/server";

describe("AppShell", () => {
	it("shows the signed-in user and every nav item to an admin", async () => {
		renderApp("/");
		expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
		for (const name of [
			"Overview",
			"Projects",
			"Endpoints",
			"Events",
			"Failures",
			"Audit",
			"Settings",
		]) {
			expect(screen.getByRole("link", { name })).toBeInTheDocument();
		}
	});

	it("hides Audit from viewers", async () => {
		renderApp("/", { role: "viewer" });
		await screen.findByText("viewer@example.com");
		expect(
			screen.queryByRole("link", { name: "Audit" }),
		).not.toBeInTheDocument();
	});

	it("refetches /me after a 403 from any call", async () => {
		let meCalls = 0;
		server.use(
			http.get(apiUrl("/me"), () => {
				meCalls++;
				return HttpResponse.json({
					username: "admin@example.com",
					role: "admin",
					permissions: ["events.read"],
				});
			}),
		);
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json(
					{ error: "forbidden", required: "events.read" },
					{ status: 403 },
				),
			),
		);
		const { queryClient } = renderApp("/");
		await screen.findByText("admin@example.com");
		await queryClient
			.fetchQuery({
				queryKey: ["probe403"],
				queryFn: () => import("@/lib/api").then((m) => m.api.get("/projects")),
			})
			.catch(() => {});
		await waitFor(() => expect(meCalls).toBeGreaterThanOrEqual(2));
	});

	it("shows an error with Retry when /me fails with a non-403 error", async () => {
		let fail = true;
		server.use(
			http.get(apiUrl("/me"), () =>
				fail
					? HttpResponse.json({ error: "internal" }, { status: 500 })
					: HttpResponse.json({
							username: "admin@example.com",
							role: "admin",
							permissions: ["events.read"],
						}),
			),
		);
		const { user } = renderApp("/");
		await user.click(await screen.findByRole("button", { name: "Retry" }));
		expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
		fail = false;
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
	});

	it("shows a user menu with the username, role, and account actions", async () => {
		renderApp("/");
		await screen.findByText("admin@example.com");
		expect(screen.getByText("admin")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Change password" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
	});

	it("logs out via POST /auth/logout and navigates to /login", async () => {
		const loggedOut = vi.fn();
		server.use(
			http.post(apiUrl("/auth/logout"), () => {
				loggedOut();
				return new HttpResponse(null, { status: 204 });
			}),
		);
		const { user, router } = renderApp("/");
		await screen.findByText("admin@example.com");
		await user.click(screen.getByRole("button", { name: "Log out" }));
		await waitFor(() => expect(loggedOut).toHaveBeenCalled());
		await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
	});

	it("changes the password and shows Current password is incorrect on wrong_password", async () => {
		const changed = vi.fn();
		server.use(
			http.post(apiUrl("/me/password"), async ({ request }) => {
				changed(await request.json());
				return HttpResponse.json({ error: "wrong_password" }, { status: 401 });
			}),
		);
		const { user } = renderApp("/");
		await screen.findByText("admin@example.com");
		await user.click(screen.getByRole("button", { name: "Change password" }));
		await user.type(
			await screen.findByLabelText("Current password"),
			"old-password-is-long",
		);
		await user.type(
			screen.getByLabelText("New password"),
			"a-brand-new-password",
		);
		await user.type(
			screen.getByLabelText("Confirm new password"),
			"a-brand-new-password",
		);
		await user.click(screen.getByRole("button", { name: "Save password" }));
		await waitFor(() =>
			expect(changed).toHaveBeenCalledWith({
				current_password: "old-password-is-long",
				new_password: "a-brand-new-password",
			}),
		);
		expect(
			await screen.findByText("Current password is incorrect"),
		).toBeInTheDocument();
		// A wrong_password 401 is not an expired session: the user stays put.
		expect(
			screen.queryByRole("button", { name: "Sign in" }),
		).not.toBeInTheDocument();
	});

	it("preserves leading/trailing spaces in the new password", async () => {
		const changed = vi.fn();
		server.use(
			http.post(apiUrl("/me/password"), async ({ request }) => {
				changed(await request.json());
				return new HttpResponse(null, { status: 204 });
			}),
		);
		const { user } = renderApp("/");
		await screen.findByText("admin@example.com");
		await user.click(screen.getByRole("button", { name: "Change password" }));
		await user.type(
			await screen.findByLabelText("Current password"),
			"old-password-is-long",
		);
		await user.type(
			screen.getByLabelText("New password"),
			"  secret-with-spaces  ",
		);
		await user.type(
			screen.getByLabelText("Confirm new password"),
			"  secret-with-spaces  ",
		);
		await user.click(screen.getByRole("button", { name: "Save password" }));
		await waitFor(() =>
			expect(changed).toHaveBeenCalledWith({
				current_password: "old-password-is-long",
				new_password: "  secret-with-spaces  ",
			}),
		);
	});

	it("sends an expired session to /login?next=<here> on a 401", async () => {
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
			),
		);
		const { queryClient, router } = renderApp("/projects");
		await screen.findByText("admin@example.com");
		await queryClient
			.fetchQuery({
				queryKey: ["probe401"],
				queryFn: () => import("@/lib/api").then((m) => m.api.get("/projects")),
			})
			.catch(() => {});
		await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
		await waitFor(() =>
			expect(router.state.location.search).toMatchObject({
				next: "/projects",
			}),
		);
	});

	it("renders the Monitor, Configure, and Administer navigation groups", async () => {
		renderApp("/");
		await screen.findByText("admin@example.com");
		for (const group of ["Monitor", "Configure", "Administer"]) {
			expect(
				screen.getByRole("heading", { name: group }),
			).toBeInTheDocument();
		}
	});

	it("marks a detail route's parent nav item active with background and weight", async () => {
		server.use(
			http.get(apiUrl("/events/evt_1"), () =>
				HttpResponse.json({ error: "not_found" }, { status: 404 }),
			),
		);
		renderApp("/events/evt_1");
		await screen.findByText("admin@example.com");
		const nav = screen.getByRole("navigation", { name: "Main" });
		const events = within(nav).getByRole("link", { name: "Events" });
		// Background plus weight, not color alone (spec §6).
		expect(events).toHaveClass("bg-selected");
		expect(events).toHaveClass("font-medium");
		expect(events).toHaveAttribute("aria-current", "page");
		const failures = within(nav).getByRole("link", { name: "Failures" });
		expect(failures).not.toHaveClass("bg-selected");
		expect(failures).not.toHaveClass("font-medium");
		expect(failures).not.toHaveAttribute("aria-current");
	});

	it("opens the navigation drawer, closes it with Escape, and restores focus", async () => {
		const { user } = renderApp("/");
		await screen.findByText("admin@example.com");
		const trigger = screen.getByRole("button", { name: "Open navigation" });
		await user.click(trigger);
		const drawer = await screen.findByRole("dialog");
		// Two copies of the links legitimately exist while the drawer is open.
		expect(
			within(drawer).getByRole("link", { name: "Events" }),
		).toBeInTheDocument();
		// Focus moves into the drawer and stays there when tabbing past its end.
		expect(drawer.contains(document.activeElement)).toBe(true);
		await user.tab();
		await user.tab();
		expect(drawer.contains(document.activeElement)).toBe(true);
		await user.keyboard("{Escape}");
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(trigger).toHaveFocus();
	});

	it("closes the navigation drawer after navigating from it", async () => {
		const { user, router } = renderApp("/events");
		await screen.findByText("admin@example.com");
		await user.click(screen.getByRole("button", { name: "Open navigation" }));
		const drawer = await screen.findByRole("dialog");
		await user.click(within(drawer).getByRole("link", { name: "Failures" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/failures"),
		);
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});

	it("offers a skip link that targets the main content landmark", async () => {
		renderApp("/");
		await screen.findByText("admin@example.com");
		const skip = screen.getByRole("link", { name: "Skip to content" });
		expect(skip).toHaveAttribute("href", "#main-content");
		expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
	});

	it("clears cached data and lands on /login even when logout fails", async () => {
		const seeded = ["projects", "list", {}] as const;
		let attempts = 0;
		server.use(
			http.post(apiUrl("/auth/logout"), () => {
				attempts++;
				return HttpResponse.json({ error: "internal" }, { status: 500 });
			}),
		);
		const { user, router, queryClient } = renderApp("/");
		await screen.findByText("admin@example.com");
		queryClient.setQueryData(seeded, { data: [], next_cursor: null });
		expect(queryClient.getQueryData(seeded)).toBeDefined();
		await user.click(screen.getByRole("button", { name: "Log out" }));
		await waitFor(() => expect(attempts).toBeGreaterThanOrEqual(1));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/login"),
		);
		expect(queryClient.getQueryData(seeded)).toBeUndefined();
	});

	it("hides administrative navigation after a 403 downgrades /me", async () => {
		let role: "admin" | "viewer" = "admin";
		server.use(http.get(apiUrl("/me"), () => HttpResponse.json(meFor(role))));
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json(
					{ error: "forbidden", required: "config.write" },
					{ status: 403 },
				),
			),
		);
		const { queryClient } = renderApp("/");
		await screen.findByText("admin@example.com");
		expect(screen.getByRole("link", { name: "Audit" })).toBeInTheDocument();
		role = "viewer";
		await queryClient
			.fetchQuery({
				queryKey: ["probe403"],
				queryFn: () => import("@/lib/api").then((m) => m.api.get("/projects")),
			})
			.catch(() => {});
		// The shell refetches /me and downgrades its administrative controls.
		await screen.findByText("viewer@example.com");
		expect(
			screen.queryByRole("link", { name: "Audit" }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
	});
});
