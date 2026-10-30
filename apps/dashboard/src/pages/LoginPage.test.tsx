import { QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/router";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";
import { LoginPage } from "./LoginPage";

/** Renders the page without the root auth-state guard, so pending/failed
 *  auth-state is observable instead of blocking navigation. */
function renderBare(page: ReactNode) {
	const queryClient = createQueryClient();
	const rootRoute = createRootRoute({ component: () => page });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/login"] }),
	});
	const user = userEvent.setup();
	render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return { user };
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

afterEach(() => {
	window.turnstile = undefined;
});

const withSiteKey = () =>
	server.use(
		http.get(apiUrl("/auth/state"), () =>
			HttpResponse.json({
				setup_required: false,
				turnstile_site_key: "1x00000000000000000000AA",
			}),
		),
	);

describe("LoginPage", () => {
	it("uses the exact heading", async () => {
		renderApp("/login");
		expect(
			await screen.findByRole("heading", { name: "Sign in to Hookflare" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
		expect(
			screen.getByRole("region", { name: "Sign in to Hookflare" }),
		).toContainElement(screen.getByLabelText("Password"));
	});

	it("does not claim Turnstile is off while auth-state is still pending", async () => {
		server.use(
			http.get(apiUrl("/auth/state"), () => new Promise<Response>(() => {})),
		);
		renderBare(<LoginPage />);
		expect(await screen.findByRole("status")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
		expect(
			screen.queryByText(/bot protection is off/i),
		).not.toBeInTheDocument();
		expect(screen.queryByText(/turnstile is off/i)).not.toBeInTheDocument();
	});

	it("shows an error panel with Retry and blocks submission when auth-state fails", async () => {
		let fail = true;
		server.use(
			http.get(apiUrl("/auth/state"), () =>
				fail
					? HttpResponse.json({ error: "internal" }, { status: 500 })
					: HttpResponse.json({
							setup_required: false,
							turnstile_site_key: null,
						}),
			),
		);
		const { user } = renderBare(<LoginPage />);
		expect(await screen.findByText(/could not load sign/i)).toBeInTheDocument();
		const retry = screen.getByRole("button", { name: "Retry" });
		expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
		fail = false;
		await user.click(retry);
		expect(
			await screen.findByText(/bot protection is off/i),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
	});

	it("keeps submit disabled until Turnstile yields a token", async () => {
		withSiteKey();
		const turnstile = stubTurnstile();
		renderApp("/login");
		await screen.findByLabelText("Username");
		const submit = screen.getByRole("button", { name: "Sign in" });
		expect(submit).toBeDisabled();
		await waitFor(() => expect(turnstile.render).toHaveBeenCalled());
		turnstile.challenge.callback?.("token-1");
		await waitFor(() => expect(submit).toBeEnabled());
	});

	it("disables submit again when the challenge expires and surfaces a load error", async () => {
		withSiteKey();
		const turnstile = stubTurnstile();
		const { user } = renderApp("/login");
		await user.type(await screen.findByLabelText("Username"), "admin");
		const submit = screen.getByRole("button", { name: "Sign in" });
		await waitFor(() => expect(turnstile.render).toHaveBeenCalled());
		turnstile.challenge.callback?.("token-1");
		await waitFor(() => expect(submit).toBeEnabled());
		turnstile.challenge.expired?.();
		await waitFor(() => expect(submit).toBeDisabled());
		turnstile.challenge.error?.();
		expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
		expect(submit).toBeDisabled();
	});

	it("shows Invalid username or password on a 401 and resets the widget", async () => {
		withSiteKey();
		server.use(
			http.post(apiUrl("/auth/login"), () =>
				HttpResponse.json({ error: "invalid_credentials" }, { status: 401 }),
			),
		);
		const turnstile = stubTurnstile();
		const { user } = renderApp("/login");
		await user.type(await screen.findByLabelText("Username"), "admin");
		await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
		await waitFor(() => expect(turnstile.render).toHaveBeenCalled());
		turnstile.challenge.callback?.("token-1");
		const submit = screen.getByRole("button", { name: "Sign in" });
		await waitFor(() => expect(submit).toBeEnabled());
		await user.click(submit);
		expect(
			await screen.findByText("Invalid username or password"),
		).toBeInTheDocument();
		await waitFor(() => expect(turnstile.reset).toHaveBeenCalled());
	});

	it("shows the rate-limit message on a 429", async () => {
		server.use(
			http.post(apiUrl("/auth/login"), () =>
				HttpResponse.json({ error: "too_many_attempts" }, { status: 429 }),
			),
		);
		const { user } = renderApp("/login");
		await user.type(await screen.findByLabelText("Username"), "admin");
		await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
		await user.click(screen.getByRole("button", { name: "Sign in" }));
		expect(
			await screen.findByText("Too many attempts, try again in a minute"),
		).toBeInTheDocument();
	});

	it("shows an inline error for a non-401/429 failure (403)", async () => {
		server.use(
			http.post(apiUrl("/auth/login"), () =>
				HttpResponse.json({ error: "turnstile_failed" }, { status: 403 }),
			),
		);
		const { user } = renderApp("/login");
		await user.type(await screen.findByLabelText("Username"), "admin");
		await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
		await user.click(screen.getByRole("button", { name: "Sign in" }));
		expect(await screen.findByText("turnstile_failed")).toBeInTheDocument();
	});

	it("navigates to safeNext(next) on success", async () => {
		const { user, router } = renderApp("/login?next=/projects");
		await user.type(await screen.findByLabelText("Username"), "admin");
		await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
		await user.click(screen.getByRole("button", { name: "Sign in" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/projects"),
		);
	});

	it("falls back to / for an open-redirect next", async () => {
		const { user, router } = renderApp(
			"/login?next=https%3A%2F%2Fevil.example",
		);
		await user.type(await screen.findByLabelText("Username"), "admin");
		await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
		await user.click(screen.getByRole("button", { name: "Sign in" }));
		await waitFor(() => expect(router.state.location.pathname).toBe("/"));
	});

	it("shows a neutral off notice when no site key is configured", async () => {
		renderApp("/login");
		expect(
			await screen.findByText("Bot protection is off."),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
	});

	it("reveals the password without losing its value", async () => {
		const { user } = renderApp("/login");
		const password = (await screen.findByLabelText(
			"Password",
		)) as HTMLInputElement;
		await user.type(password, "correct-horse-battery");
		expect(password).toHaveAttribute("autoComplete", "current-password");
		await user.click(screen.getByRole("button", { name: "Show Password" }));
		expect(password).toHaveAttribute("type", "text");
		expect(password.value).toBe("correct-horse-battery");
	});

	it("sends only one login POST when submitted twice while pending", async () => {
		let posted = 0;
		let release!: (value: Response) => void;
		server.use(
			http.post(
				apiUrl("/auth/login"),
				() =>
					new Promise<Response>((resolve) => {
						posted++;
						release = resolve;
					}),
			),
		);
		const { user, router } = renderApp("/login");
		await user.type(await screen.findByLabelText("Username"), "admin");
		await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
		const submit = screen.getByRole("button", { name: "Sign in" });
		await user.click(submit);
		await waitFor(() => expect(submit).toBeDisabled());
		await user.click(submit);
		release(new HttpResponse(null, { status: 204 }));
		await waitFor(() => expect(router.state.location.pathname).toBe("/"));
		expect(posted).toBe(1);
	});

	it("never trims the password it sends", async () => {
		const posted = vi.fn();
		server.use(
			http.post(apiUrl("/auth/login"), async ({ request }) => {
				posted(await request.json());
				return new HttpResponse(null, { status: 204 });
			}),
		);
		const { user } = renderApp("/login");
		await user.type(await screen.findByLabelText("Username"), "admin");
		await user.type(
			screen.getByLabelText("Password"),
			"  correct-horse-battery  ",
		);
		await user.click(screen.getByRole("button", { name: "Sign in" }));
		await waitFor(() =>
			expect(posted).toHaveBeenCalledWith(
				expect.objectContaining({ password: "  correct-horse-battery  " }),
			),
		);
	});
});
