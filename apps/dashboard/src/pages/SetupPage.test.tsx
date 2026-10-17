import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

/** `/setup` only renders while onboarding is open, so keep the state true. */
function setupOpen() {
	server.use(
		http.get(apiUrl("/auth/state"), () =>
			HttpResponse.json({ setup_required: true, turnstile_site_key: null }),
		),
	);
}

async function fill(
	user: ReturnType<typeof renderApp>["user"],
	confirm = "correct-horse",
) {
	await user.type(await screen.findByLabelText("Username"), "admin");
	await user.type(screen.getByLabelText("Password"), "correct-horse");
	await user.type(screen.getByLabelText("Confirm password"), confirm);
	await user.type(screen.getByLabelText("Setup token"), "setup-token");
}

describe("SetupPage", () => {
	it("blocks submit and reports a password-confirm mismatch", async () => {
		setupOpen();
		const posted = vi.fn();
		server.use(
			http.post(apiUrl("/auth/setup"), async ({ request }) => {
				posted(await request.json());
				return HttpResponse.json({}, { status: 201 });
			}),
		);
		const { user } = renderApp("/setup");
		await fill(user, "correct-horsx");
		await user.click(screen.getByRole("button", { name: "Create admin" }));
		expect(
			await screen.findByText("Passwords do not match"),
		).toBeInTheDocument();
		expect(posted).not.toHaveBeenCalled();
	});

	it("sends a closed setup (409) to the login page", async () => {
		let open = true;
		server.use(
			http.get(apiUrl("/auth/state"), () =>
				HttpResponse.json({
					setup_required: open,
					turnstile_site_key: null,
				}),
			),
			http.post(apiUrl("/auth/setup"), () => {
				open = false;
				return HttpResponse.json({ error: "setup_closed" }, { status: 409 });
			}),
		);
		const { user, router } = renderApp("/setup");
		await fill(user);
		await user.click(screen.getByRole("button", { name: "Create admin" }));
		await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
	});

	it("navigates home after a successful setup", async () => {
		let open = true;
		server.use(
			http.get(apiUrl("/auth/state"), () =>
				HttpResponse.json({
					setup_required: open,
					turnstile_site_key: null,
				}),
			),
			http.post(apiUrl("/auth/setup"), () => {
				open = false;
				return HttpResponse.json(
					{ username: "admin", role: "admin" },
					{ status: 201 },
				);
			}),
		);
		const { user, router } = renderApp("/setup");
		await fill(user);
		await user.click(screen.getByRole("button", { name: "Create admin" }));
		await waitFor(() => expect(router.state.location.pathname).toBe("/"));
	});

	it("shows the Turnstile-off notice when no site key is configured", async () => {
		setupOpen();
		renderApp("/setup");
		expect(await screen.findByText("Turnstile is off")).toBeInTheDocument();
	});
});
