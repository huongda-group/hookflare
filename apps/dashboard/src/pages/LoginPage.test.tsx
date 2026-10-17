import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

/** Stands in for the Turnstile `api.js` script the widget loads at runtime. */
function stubTurnstile() {
	const callbacks: ((token: string) => void)[] = [];
	const render = vi.fn(
		(_el: HTMLElement, opts: { callback: (token: string) => void }) => {
			callbacks.push(opts.callback);
			return "widget-1";
		},
	);
	const reset = vi.fn();
	window.turnstile = { render, reset } as never;
	return {
		render,
		reset,
		yieldToken: (token: string) => callbacks.at(-1)?.(token),
	};
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
	it("keeps submit disabled until Turnstile yields a token", async () => {
		withSiteKey();
		const turnstile = stubTurnstile();
		renderApp("/login");
		await screen.findByLabelText("Username");
		const submit = screen.getByRole("button", { name: "Sign in" });
		expect(submit).toBeDisabled();
		await waitFor(() => expect(turnstile.render).toHaveBeenCalled());
		turnstile.yieldToken("token-1");
		await waitFor(() => expect(submit).toBeEnabled());
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
		turnstile.yieldToken("token-1");
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

	it("works with Turnstile off", async () => {
		renderApp("/login");
		expect(await screen.findByText("Turnstile is off")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
	});
});
