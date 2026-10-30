import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

const op = {
	username: "op",
	role: "operator",
	created_at: 0,
	updated_at: 0,
	disabled_at: null,
	has_password: true,
};

const usersList = () =>
	server.use(
		http.get(apiUrl("/users"), () =>
			HttpResponse.json({ data: [op], next_cursor: null }),
		),
	);

const tokensList = (tokens: unknown[]) =>
	server.use(
		http.get(apiUrl("/users/op/tokens"), () =>
			HttpResponse.json({ data: tokens }),
		),
	);

async function openTokens(user: { click: (el: Element) => Promise<void> }) {
	await user.click(
		await screen.findByRole("button", { name: "API tokens for op" }),
	);
}

describe("ApiTokensDialog", () => {
	it("shows the created token exactly once and forgets it on close and remount", async () => {
		const secret = "hf_once-only-secret-value";
		usersList();
		tokensList([]);
		server.use(
			http.post(apiUrl("/users/op/tokens"), () =>
				HttpResponse.json(
					{
						id: "tok_2",
						username: "op",
						name: "bench",
						created_at: 2,
						expires_at: null,
						last_used_at: null,
						revoked_at: null,
						token: secret,
					},
					{ status: 201 },
				),
			),
		);
		const { user, queryClient } = renderApp("/settings?tab=users");
		expect(await screen.findByText("op")).toBeInTheDocument();
		await openTokens(user);
		expect(await screen.findByText("No API tokens yet.")).toBeInTheDocument();
		await user.type(await screen.findByLabelText("Token name"), "bench");
		await user.click(screen.getByRole("button", { name: "Create token" }));
		expect(await screen.findByText(secret)).toBeInTheDocument();
		// The reveal is gated: acknowledging it closes the one-time disclosure.
		await user.click(screen.getByLabelText("I have stored this secret"));
		await user.click(screen.getByRole("button", { name: "Done" }));
		await waitFor(() =>
			expect(screen.queryByText(secret)).not.toBeInTheDocument(),
		);
		// The plaintext never lands in Query storage.
		for (const q of queryClient.getQueryCache().getAll()) {
			expect(JSON.stringify(q.state.data ?? null)).not.toContain(secret);
		}
		// Closing and remounting the dialog shows no raw token.
		const dialog = screen.getByRole("dialog", { name: "API tokens for op" });
		await user.click(
			within(dialog).getByRole("button", { name: "Close" }),
		);
		await waitFor(() =>
			expect(
				screen.queryByRole("dialog", { name: "API tokens for op" }),
			).not.toBeInTheDocument(),
		);
		await user.click(
			await screen.findByRole("button", { name: "API tokens for op" }),
		);
		expect(
			await screen.findByRole("dialog", { name: "API tokens for op" }),
		).toBeInTheDocument();
		expect(screen.queryByText(secret)).not.toBeInTheDocument();
		for (const q of queryClient.getQueryCache().getAll()) {
			expect(JSON.stringify(q.state.data ?? null)).not.toContain(secret);
		}
	});

	it("names the token in the revoke confirmation", async () => {
		usersList();
		tokensList([
			{
				id: "tok_1",
				username: "op",
				name: "smoke",
				created_at: 1,
				expires_at: null,
				last_used_at: null,
				revoked_at: null,
			},
		]);
		const { user } = renderApp("/settings?tab=users");
		expect(await screen.findByText("op")).toBeInTheDocument();
		await openTokens(user);
		await user.click(
			await screen.findByRole("button", { name: "Revoke token smoke" }),
		);
		expect(
			await screen.findByRole("heading", { name: "Revoke token smoke?" }),
		).toBeInTheDocument();
	});

	it("surfaces a downgrade 403 inline without a refetch storm", async () => {
		let listCalls = 0;
		usersList();
		server.use(
			http.get(apiUrl("/users/op/tokens"), () => {
				listCalls++;
				return HttpResponse.json(
					{ error: "forbidden", required: "users.manage" },
					{ status: 403 },
				);
			}),
		);
		const { user } = renderApp("/settings?tab=users");
		expect(await screen.findByText("op")).toBeInTheDocument();
		await openTokens(user);
		expect(await screen.findByText(/forbidden/)).toBeInTheDocument();
		// The dialog stays open on readable feedback and never retries.
		expect(
			screen.getByRole("dialog", { name: "API tokens for op" }),
		).toBeInTheDocument();
		await new Promise((r) => setTimeout(r, 300));
		expect(listCalls).toBe(1);
	});

	it("sends an expired session to /login from the tokens dialog", async () => {
		usersList();
		server.use(
			http.get(apiUrl("/users/op/tokens"), () =>
				HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
			),
		);
		const { user, router } = renderApp("/settings?tab=users");
		expect(await screen.findByText("op")).toBeInTheDocument();
		await openTokens(user);
		await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
	});

	it.each(["operator", "viewer"] as const)(
		"hides token management from %s without firing token requests",
		async (role) => {
			const usersCalls = vi.fn();
			const tokenCalls = vi.fn();
			server.use(
				http.get(apiUrl("/users"), () => {
					usersCalls();
					return HttpResponse.json({ data: [], next_cursor: null });
				}),
				http.get(apiUrl("/users/op/tokens"), () => {
					tokenCalls();
					return HttpResponse.json({ data: [] });
				}),
			);
			renderApp("/settings?tab=users", { role });
			// The Users tab itself is gated; retry settings render instead.
			expect(
				await screen.findByRole("tab", { name: "Retry defaults" }),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("tab", { name: "Users" }),
			).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "API tokens for op" }),
			).not.toBeInTheDocument();
			await new Promise((r) => setTimeout(r, 200));
			expect(usersCalls).not.toHaveBeenCalled();
			expect(tokenCalls).not.toHaveBeenCalled();
		},
	);

	it("shows a token create conflict inline and keeps the dialog open", async () => {
		usersList();
		tokensList([]);
		server.use(
			http.post(apiUrl("/users/op/tokens"), () =>
				HttpResponse.json({ error: "conflict" }, { status: 409 }),
			),
		);
		const { user } = renderApp("/settings?tab=users");
		expect(await screen.findByText("op")).toBeInTheDocument();
		await openTokens(user);
		await user.type(await screen.findByLabelText("Token name"), "bench");
		await user.click(screen.getByRole("button", { name: "Create token" }));
		expect(await screen.findByText(/conflict/)).toBeInTheDocument();
		expect(
			screen.getByRole("dialog", { name: "API tokens for op" }),
		).toBeInTheDocument();
	});
});
