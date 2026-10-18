import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/router";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";
import { SetupPage } from "./SetupPage";

/** Renders the page without the root auth-state guard, so pending/failed
 *  auth-state is observable instead of blocking navigation. */
function renderBare(page: ReactNode) {
	const queryClient = createQueryClient();
	const rootRoute = createRootRoute({ component: () => page });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/setup"] }),
	});
	const user = userEvent.setup();
	render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return { user };
}

/** `/setup` only renders while onboarding is open, so keep the state true. */
function setupOpen() {
	server.use(
		http.get(apiUrl("/auth/state"), () =>
			HttpResponse.json({ setup_required: true, turnstile_site_key: null }),
		),
	);
}

function setupWithSiteKey() {
	server.use(
		http.get(apiUrl("/auth/state"), () =>
			HttpResponse.json({
				setup_required: true,
				turnstile_site_key: "1x00000000000000000000AA",
			}),
		),
	);
}

/** Stands in for the Turnstile `api.js` script the widget loads at runtime. */
function stubTurnstile() {
	const challenge: {
		callback?: (token: string) => void;
		expired?: () => void;
		error?: () => void;
	} = {};
	const render = vi.fn(
		(
			_el: HTMLElement,
			opts: {
				callback: (token: string) => void;
				"expired-callback"?: () => void;
				"error-callback"?: () => void;
			},
		) => {
			challenge.callback = opts.callback;
			challenge.expired = opts["expired-callback"];
			challenge.error = opts["error-callback"];
			return "widget-1";
		},
	);
	const reset = vi.fn();
	window.turnstile = { render, reset };
	return { render, reset, challenge };
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
	it("uses the exact headings, description, and submit label", async () => {
		setupOpen();
		renderApp("/setup");
		expect(
			await screen.findByRole("heading", { name: "Set up your instance" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Create the first administrator account to get started."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Create admin account" }),
		).toBeInTheDocument();
	});

	it("masks the setup token and points at SETUP_TOKEN plus a setup guide", async () => {
		setupOpen();
		renderApp("/setup");
		const token = await screen.findByLabelText("Setup token");
		expect(token).toHaveAttribute("type", "password");
		expect(screen.getByText(/SETUP_TOKEN/)).toBeInTheDocument();
		expect(screen.getByText(/\.dev\.vars/)).toBeInTheDocument();
		const guide = screen.getByRole("link", { name: /setup guide/i });
		expect(guide).toHaveAttribute(
			"href",
			"https://github.com/huongda-group/hookflare/blob/main/docs/runbook/setup.md",
		);
	});

	it("shows and hides the password without losing the value", async () => {
		setupOpen();
		const { user } = renderApp("/setup");
		const password = (await screen.findByLabelText("Password")) as HTMLInputElement;
		await user.type(password, "correct-horse");
		expect(password).toHaveAttribute("autoComplete", "new-password");
		await user.click(screen.getByRole("button", { name: "Show Password" }));
		expect(password).toHaveAttribute("type", "text");
		expect(password.value).toBe("correct-horse");
		await user.click(screen.getByRole("button", { name: "Hide Password" }));
		expect(password).toHaveAttribute("type", "password");
		expect(password.value).toBe("correct-horse");
	});

	it("does not claim Turnstile is off while auth-state is still pending", async () => {
		server.use(
			http.get(apiUrl("/auth/state"), () => new Promise<Response>(() => {})),
		);
		renderBare(<SetupPage />);
		expect(await screen.findByRole("status")).toBeInTheDocument();
		const submit = screen.getByRole("button", {
			name: "Create admin account",
		});
		expect(submit).toBeDisabled();
		expect(screen.queryByText(/bot protection is off/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/turnstile is off/i)).not.toBeInTheDocument();
	});

	it("shows an error panel with Retry and blocks submission when auth-state fails", async () => {
		let fail = true;
		server.use(
			http.get(apiUrl("/auth/state"), () =>
				fail
					? HttpResponse.json({ error: "internal" }, { status: 500 })
					: HttpResponse.json({ setup_required: true, turnstile_site_key: null }),
			),
		);
		const { user } = renderBare(<SetupPage />);
		expect(await screen.findByText(/could not load setup/i)).toBeInTheDocument();
		const retry = screen.getByRole("button", { name: "Retry" });
		expect(
			screen.getByRole("button", { name: "Create admin account" }),
		).toBeDisabled();
		fail = false;
		await user.click(retry);
		expect(
			await screen.findByText(/bot protection is off/i),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Create admin account" }),
		).toBeEnabled();
	});

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
		await user.click(
			screen.getByRole("button", { name: "Create admin account" }),
		);
		expect(
			await screen.findByText("Passwords do not match"),
		).toBeInTheDocument();
		expect(posted).not.toHaveBeenCalled();
	});

	it("shows the server's inline error for a wrong setup token (401)", async () => {
		setupOpen();
		server.use(
			http.post(apiUrl("/auth/setup"), () =>
				HttpResponse.json({ error: "invalid_credentials" }, { status: 401 }),
			),
		);
		const { user } = renderApp("/setup");
		await fill(user);
		await user.click(
			screen.getByRole("button", { name: "Create admin account" }),
		);
		expect(await screen.findByText("invalid_credentials")).toBeInTheDocument();
	});

	it("points at the SETUP_TOKEN command when the token is unset (503)", async () => {
		setupOpen();
		server.use(
			http.post(apiUrl("/auth/setup"), () =>
				HttpResponse.json({ error: "setup_token_missing" }, { status: 503 }),
			),
		);
		const { user } = renderApp("/setup");
		await fill(user);
		await user.click(
			screen.getByRole("button", { name: "Create admin account" }),
		);
		expect(
			await screen.findByText(
				"Set the SETUP_TOKEN secret first: wrangler secret put SETUP_TOKEN",
			),
		).toBeInTheDocument();
	});

	it("shows the rate-limit message on a 429", async () => {
		setupOpen();
		server.use(
			http.post(apiUrl("/auth/setup"), () =>
				HttpResponse.json({ error: "too_many_attempts" }, { status: 429 }),
			),
		);
		const { user } = renderApp("/setup");
		await fill(user);
		await user.click(
			screen.getByRole("button", { name: "Create admin account" }),
		);
		expect(
			await screen.findByText("Too many attempts, try again in a minute"),
		).toBeInTheDocument();
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
		await user.click(
			screen.getByRole("button", { name: "Create admin account" }),
		);
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
		await user.click(
			screen.getByRole("button", { name: "Create admin account" }),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe("/"));
	});

	it("keeps submit disabled until Turnstile yields a token when a site key is set", async () => {
		setupWithSiteKey();
		const turnstile = stubTurnstile();
		renderApp("/setup");
		await screen.findByLabelText("Username");
		const submit = screen.getByRole("button", {
			name: "Create admin account",
		});
		expect(submit).toBeDisabled();
		await waitFor(() => expect(turnstile.render).toHaveBeenCalled());
		turnstile.challenge.callback?.("token-1");
		await waitFor(() => expect(submit).toBeEnabled());
	});

	it("disables submit again when the challenge expires and surfaces a load error", async () => {
		setupWithSiteKey();
		const turnstile = stubTurnstile();
		const { user } = renderApp("/setup");
		await user.type(await screen.findByLabelText("Username"), "admin");
		const submit = screen.getByRole("button", {
			name: "Create admin account",
		});
		await waitFor(() => expect(turnstile.render).toHaveBeenCalled());
		turnstile.challenge.callback?.("token-1");
		await waitFor(() => expect(submit).toBeEnabled());
		turnstile.challenge.expired?.();
		await waitFor(() => expect(submit).toBeDisabled());
		turnstile.challenge.error?.();
		expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
		expect(submit).toBeDisabled();
	});

	it("shows a neutral off notice that still requires the setup token", async () => {
		setupOpen();
		renderApp("/setup");
		expect(
			await screen.findByText(/bot protection is off/i),
		).toBeInTheDocument();
		expect(screen.getByText(/setup token is still required/i)).toBeInTheDocument();
	});

	it("sends only one setup POST when submitted twice while pending", async () => {
		setupOpen();
		let posted = 0;
		let release!: (value: Response) => void;
		server.use(
			http.post(
				apiUrl("/auth/setup"),
				() =>
					new Promise<Response>((resolve) => {
						posted++;
						release = resolve;
					}),
			),
		);
		const { user, router } = renderApp("/setup");
		await fill(user);
		const submit = screen.getByRole("button", {
			name: "Create admin account",
		});
		await user.click(submit);
		await waitFor(() => expect(submit).toBeDisabled());
		await user.click(submit);
		release(HttpResponse.json({ username: "admin", role: "admin" }));
		await waitFor(() => expect(router.state.location.pathname).toBe("/"));
		expect(posted).toBe(1);
	});

	it("never trims the password it sends", async () => {
		setupOpen();
		const posted = vi.fn();
		server.use(
			http.post(apiUrl("/auth/setup"), async ({ request }) => {
				posted(await request.json());
				return HttpResponse.json({ username: "admin", role: "admin" });
			}),
		);
		const { user } = renderApp("/setup");
		await user.type(await screen.findByLabelText("Username"), "admin");
		await user.type(
			screen.getByLabelText("Password"),
			"  correct horse  ",
		);
		await user.type(
			screen.getByLabelText("Confirm password"),
			"  correct horse  ",
		);
		await user.type(screen.getByLabelText("Setup token"), "setup-token");
		await user.click(
			screen.getByRole("button", { name: "Create admin account" }),
		);
		await waitFor(() =>
			expect(posted).toHaveBeenCalledWith(
				expect.objectContaining({ password: "  correct horse  " }),
			),
		);
	});
});
