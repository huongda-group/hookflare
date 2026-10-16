import { screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render";
import { apiUrl, DEFAULT_SETTINGS, server } from "@/test/server";

describe("Settings", () => {
	it("shows retry defaults read-only to viewers", async () => {
		renderApp("/settings", { role: "viewer" });
		expect(await screen.findByLabelText("Max attempts")).toBeDisabled();
		expect(
			screen.queryByRole("button", { name: "Save" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("tab", { name: "Users" }),
		).not.toBeInTheDocument();
	});

	it("rejects base > max on the client, using the shared schema", async () => {
		const sent = vi.fn();
		server.use(
			http.patch(apiUrl("/settings"), async ({ request }) => {
				sent(await request.json());
				return HttpResponse.json(DEFAULT_SETTINGS);
			}),
		);
		const { user } = renderApp("/settings");
		const base = await screen.findByLabelText("Backoff base (s)");
		await user.clear(base);
		await user.type(base, "30000");
		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(
			await screen.findByText(/backoff_max_s|greater|at least/i, {
				selector: "[data-field-error]",
			}),
		).toBeInTheDocument();
		expect(sent).not.toHaveBeenCalled();
	});

	it("saves retry defaults with a reason", async () => {
		const sent = vi.fn();
		server.use(
			http.patch(apiUrl("/settings"), async ({ request }) => {
				sent(await request.json());
				return HttpResponse.json(DEFAULT_SETTINGS);
			}),
		);
		const { user } = renderApp("/settings");
		const max = await screen.findByLabelText("Max attempts");
		await user.clear(max);
		await user.type(max, "8");
		await user.type(
			screen.getByLabelText("Reason (optional)"),
			"noisy partner",
		);
		await user.click(screen.getByRole("button", { name: "Save" }));
		await vi.waitFor(() =>
			expect(sent).toHaveBeenCalledWith({
				retry_defaults: {
					timeout_ms: 10_000,
					max_attempts: 8,
					backoff_base_s: 30,
					backoff_max_s: 21_600,
				},
				reason: "noisy partner",
			}),
		);
		expect(
			await screen.findByText(/applies to new attempts within 30 seconds/i),
		).toBeInTheDocument();
	});

	it("adds a user and changes a role from the Users tab", async () => {
		const created = vi.fn();
		const patched = vi.fn();
		server.use(
			http.get(apiUrl("/users"), () =>
				HttpResponse.json({
					data: [
						{
							email: "op@example.com",
							role: "operator",
							created_at: 0,
							updated_at: 0,
							disabled_at: null,
						},
					],
					next_cursor: null,
				}),
			),
			http.post(apiUrl("/users"), async ({ request }) => {
				created(await request.json());
				return HttpResponse.json({}, { status: 201 });
			}),
			http.patch(apiUrl("/users/op%40example.com"), async ({ request }) => {
				patched(await request.json());
				return HttpResponse.json({});
			}),
		);
		const { user } = renderApp("/settings?tab=users");
		expect(await screen.findByText("op@example.com")).toBeInTheDocument();
		await user.type(screen.getByLabelText("Email"), "new@example.com");
		await user.click(screen.getByRole("button", { name: "Add user" }));
		await vi.waitFor(() =>
			expect(created).toHaveBeenCalledWith({
				email: "new@example.com",
				role: "viewer",
			}),
		);
		await user.click(
			screen.getByRole("button", { name: "Disable op@example.com" }),
		);
		await user.click(screen.getByRole("button", { name: "Disable" }));
		await vi.waitFor(() =>
			expect(patched).toHaveBeenCalledWith({ disabled: true }),
		);
	});
});
