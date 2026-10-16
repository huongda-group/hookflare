import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createQueryClient } from "@/router";
import { destination, project, source } from "@/test/fixtures";
import { apiUrl, server } from "@/test/server";
import { SourceFormDialog } from "./SourceFormDialog";

describe("SourceFormDialog", () => {
	it("drops a typed secret when auth type switches to None", async () => {
		let body: Record<string, unknown> | undefined;
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({ data: [project()], next_cursor: null }),
			),
			http.get(apiUrl("/destinations"), () =>
				HttpResponse.json({ data: [destination()], next_cursor: null }),
			),
			http.post(apiUrl("/sources"), async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return HttpResponse.json(source({ auth_type: "none" }), {
					status: 201,
				});
			}),
		);
		const user = userEvent.setup();
		render(
			<QueryClientProvider client={createQueryClient()}>
				<SourceFormDialog open onOpenChange={() => {}} />
			</QueryClientProvider>,
		);
		await user.click(screen.getByLabelText("Project"));
		await user.click(await screen.findByRole("option", { name: "Payments" }));
		await user.click(screen.getByLabelText("Destination"));
		await user.click(
			await screen.findByRole("option", { name: "Billing API" }),
		);
		await user.type(screen.getByLabelText("Name"), "Stripe");
		await user.click(screen.getByLabelText("Auth type"));
		await user.click(
			await screen.findByRole("option", { name: "HMAC signature" }),
		);
		// Too short for the shared schema; must not linger once hidden.
		await user.type(screen.getByLabelText(/^Secret/), "short");
		await user.click(screen.getByLabelText("Auth type"));
		await user.click(await screen.findByRole("option", { name: "None" }));
		expect(screen.queryByLabelText(/^Secret/)).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() => expect(body).toBeDefined());
		expect(body).not.toHaveProperty("secret");
		expect(body).toMatchObject({ auth_type: "none", auth_config: {} });
	});

	it("saves an edit without the fixed auth type", async () => {
		let body: Record<string, unknown> | undefined;
		server.use(
			http.get(apiUrl("/destinations"), () =>
				HttpResponse.json({ data: [destination()], next_cursor: null }),
			),
			http.patch(apiUrl("/sources/src_1"), async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return HttpResponse.json(source());
			}),
		);
		const user = userEvent.setup();
		render(
			<QueryClientProvider client={createQueryClient()}>
				<SourceFormDialog open onOpenChange={() => {}} source={source()} />
			</QueryClientProvider>,
		);
		const name = screen.getByLabelText("Name");
		await user.clear(name);
		await user.type(name, "Stripe live");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(body).toBeDefined());
		expect(body).toMatchObject({ name: "Stripe live" });
		expect(body).not.toHaveProperty("auth_type");
	});
});
