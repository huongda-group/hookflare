import { screen, waitFor } from "@testing-library/react";
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

describe("Settings › Users", () => {
	it("creates a user posting { username, role, password }", async () => {
		const created = vi.fn();
		usersList();
		server.use(
			http.post(apiUrl("/users"), async ({ request }) => {
				created(await request.json());
				return HttpResponse.json({}, { status: 201 });
			}),
		);
		const { user } = renderApp("/settings?tab=users");
		expect(await screen.findByText("op")).toBeInTheDocument();
		await user.type(screen.getByLabelText("Username"), "newop");
		await user.type(
			screen.getByLabelText("Password"),
			"a-long-initial-password",
		);
		await user.click(screen.getByRole("button", { name: "Add user" }));
		await waitFor(() =>
			expect(created).toHaveBeenCalledWith({
				username: "newop",
				role: "viewer",
				password: "a-long-initial-password",
			}),
		);
	});

	it("normalizes a padded username but preserves a padded password on create", async () => {
		const created = vi.fn();
		usersList();
		server.use(
			http.post(apiUrl("/users"), async ({ request }) => {
				created(await request.json());
				return HttpResponse.json({}, { status: 201 });
			}),
		);
		const { user } = renderApp("/settings?tab=users");
		expect(await screen.findByText("op")).toBeInTheDocument();
		await user.type(screen.getByLabelText("Username"), "  NewOp  ");
		await user.type(
			screen.getByLabelText("Password"),
			"  secret-with-spaces  ",
		);
		await user.click(screen.getByRole("button", { name: "Add user" }));
		await waitFor(() =>
			expect(created).toHaveBeenCalledWith({
				username: "newop",
				role: "viewer",
				password: "  secret-with-spaces  ",
			}),
		);
	});

	it("resets a password via POST /users/:username/password", async () => {
		const reset = vi.fn();
		usersList();
		server.use(
			http.post(apiUrl("/users/op/password"), async ({ request }) => {
				reset(await request.json());
				return new HttpResponse(null, { status: 204 });
			}),
		);
		const { user } = renderApp("/settings?tab=users");
		await user.click(
			await screen.findByRole("button", { name: "Reset password for op" }),
		);
		await user.type(
			await screen.findByLabelText("New password"),
			"a-long-reset-password",
		);
		await user.click(screen.getByRole("button", { name: "Reset password" }));
		await waitFor(() =>
			expect(reset).toHaveBeenCalledWith({
				password: "a-long-reset-password",
			}),
		);
	});

	it("preserves leading/trailing spaces when resetting a password", async () => {
		const reset = vi.fn();
		usersList();
		server.use(
			http.post(apiUrl("/users/op/password"), async ({ request }) => {
				reset(await request.json());
				return new HttpResponse(null, { status: 204 });
			}),
		);
		const { user } = renderApp("/settings?tab=users");
		await user.click(
			await screen.findByRole("button", { name: "Reset password for op" }),
		);
		await user.type(
			await screen.findByLabelText("New password"),
			"  secret-with-spaces  ",
		);
		await user.click(screen.getByRole("button", { name: "Reset password" }));
		await waitFor(() =>
			expect(reset).toHaveBeenCalledWith({
				password: "  secret-with-spaces  ",
			}),
		);
	});

	it("lists API tokens without secrets and reveals a new hf_ token once", async () => {
		const created = vi.fn();
		usersList();
		server.use(
			http.get(apiUrl("/users/op/tokens"), () =>
				HttpResponse.json({
					data: [
						{
							id: "tok_1",
							username: "op",
							name: "smoke",
							created_at: 1,
							expires_at: null,
							last_used_at: null,
							revoked_at: null,
						},
					],
				}),
			),
			http.post(apiUrl("/users/op/tokens"), async ({ request }) => {
				created(await request.json());
				return HttpResponse.json(
					{
						id: "tok_2",
						username: "op",
						name: "bench",
						created_at: 2,
						expires_at: null,
						last_used_at: null,
						revoked_at: null,
						token: "hf_new-secret-value",
					},
					{ status: 201 },
				);
			}),
		);
		const { user } = renderApp("/settings?tab=users");
		await user.click(
			await screen.findByRole("button", { name: "API tokens for op" }),
		);
		// The list shows names, never secrets.
		expect(await screen.findByText("smoke")).toBeInTheDocument();
		expect(screen.queryByText(/hf_/)).not.toBeInTheDocument();
		await user.type(await screen.findByLabelText("Token name"), "bench");
		await user.click(screen.getByRole("button", { name: "Create token" }));
		await waitFor(() =>
			expect(created).toHaveBeenCalledWith({ name: "bench" }),
		);
		// The plaintext is shown once, gated like every secret reveal.
		expect(await screen.findByText("hf_new-secret-value")).toBeInTheDocument();
		expect(
			screen.getByLabelText("I have stored this secret"),
		).toBeInTheDocument();
	});

	it("revokes a token only after confirm, then refetches the list", async () => {
		let listCalls = 0;
		const revoked = vi.fn();
		usersList();
		server.use(
			http.get(apiUrl("/users/op/tokens"), () => {
				listCalls++;
				return HttpResponse.json({ data: [] });
			}),
			http.post(apiUrl("/users/op/tokens/tok_1/revoke"), () => {
				revoked();
				return new HttpResponse(null, { status: 204 });
			}),
		);
		const { user } = renderApp("/settings?tab=users");
		await user.click(
			await screen.findByRole("button", { name: "API tokens for op" }),
		);
		expect(await screen.findByText("No API tokens yet.")).toBeInTheDocument();
		expect(listCalls).toBe(1);
		// A token created elsewhere appears after refetch; revoke confirms first.
		server.use(
			http.get(apiUrl("/users/op/tokens"), () => {
				listCalls++;
				return HttpResponse.json({
					data: [
						{
							id: "tok_1",
							username: "op",
							name: "smoke",
							created_at: 1,
							expires_at: null,
							last_used_at: null,
							revoked_at: null,
						},
					],
				});
			}),
		);
		await user.click(screen.getByRole("button", { name: "Refresh" }));
		await user.click(
			await screen.findByRole("button", { name: "Revoke token smoke" }),
		);
		expect(
			await screen.findByRole("button", { name: "Revoke" }),
		).toBeInTheDocument();
		expect(revoked).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Revoke" }));
		await waitFor(() => expect(revoked).toHaveBeenCalled());
		await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(3));
	});

	it("keeps the revoke confirm open and shows the error when revoke fails", async () => {
		usersList();
		server.use(
			http.get(apiUrl("/users/op/tokens"), () =>
				HttpResponse.json({
					data: [
						{
							id: "tok_1",
							username: "op",
							name: "smoke",
							created_at: 1,
							expires_at: null,
							last_used_at: null,
							revoked_at: null,
						},
					],
				}),
			),
			http.post(apiUrl("/users/op/tokens/tok_1/revoke"), () =>
				HttpResponse.json({ error: "internal" }, { status: 500 }),
			),
		);
		const { user } = renderApp("/settings?tab=users");
		await user.click(
			await screen.findByRole("button", { name: "API tokens for op" }),
		);
		await user.click(
			await screen.findByRole("button", { name: "Revoke token smoke" }),
		);
		await user.click(await screen.findByRole("button", { name: "Revoke" }));
		// The ConfirmDialog catches the onConfirm rejection, shows it inline,
		// and stays open instead of closing or refetching.
		expect(await screen.findByText("internal")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
	});
});
