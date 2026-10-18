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
import { type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createQueryClient } from "@/router";
import { destination, project, source } from "@/test/fixtures";
import { apiUrl, server } from "@/test/server";
import { SourceFormDialog } from "./SourceFormDialog";

/** DirtyFormGuard blocks through the router, so the dialog mounts in one. */
async function wrap(ui: ReactNode) {
	const qc = createQueryClient();
	const rootRoute = createRootRoute({
		component: () => (
			<QueryClientProvider client={qc}>{ui}</QueryClientProvider>
		),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	await router.load();
	return { user: userEvent.setup(), ...render(<RouterProvider router={router} />) };
}

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
		const { user } = await wrap(<SourceFormDialog open onOpenChange={() => {}} />);
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
		const { user } = await wrap(
			<SourceFormDialog open onOpenChange={() => {}} source={source()} />,
		);
		const name = screen.getByLabelText("Name");
		await user.clear(name);
		await user.type(name, "Stripe live");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(body).toBeDefined());
		expect(body).toMatchObject({ name: "Stripe live" });
		expect(body).not.toHaveProperty("auth_type");
	});

	it("locks project and auth during edit and leaks neither into the patch", async () => {
		let body: Record<string, unknown> | undefined;
		server.use(
			http.patch(apiUrl("/sources/src_1"), async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return HttpResponse.json(source());
			}),
		);
		const { user } = await wrap(
			<SourceFormDialog open onOpenChange={() => {}} source={source()} />,
		);
		expect(
			screen.queryByRole("combobox", { name: "Project" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("combobox", { name: "Auth type" }),
		).not.toBeInTheDocument();
		await user.type(screen.getByLabelText("Name"), " v2");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(body).toBeDefined());
		expect(body).not.toHaveProperty("project_id");
		expect(body).not.toHaveProperty("auth_type");
		expect(body).not.toHaveProperty("secret");
	});

	it("sends an edited auth config in the patch body", async () => {
		let body: Record<string, unknown> | undefined;
		server.use(
			http.patch(apiUrl("/sources/src_1"), async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return HttpResponse.json(source());
			}),
		);
		const { user } = await wrap(
			<SourceFormDialog open onOpenChange={() => {}} source={source()} />,
		);
		await user.clear(screen.getByLabelText("Signature header"));
		await user.type(screen.getByLabelText("Signature header"), "X-Sig");
		await user.click(screen.getByRole("combobox", { name: "Algorithm" }));
		await user.click(await screen.findByRole("option", { name: "SHA-512" }));
		await user.click(screen.getByRole("combobox", { name: "Encoding" }));
		await user.click(await screen.findByRole("option", { name: "base64" }));
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(body).toBeDefined());
		expect(body).toMatchObject({
			auth_config: {
				header: "X-Sig",
				algorithm: "sha512",
				encoding: "base64",
			},
		});
		expect(body).not.toHaveProperty("auth_type");
	});

	it("reaches a project beyond the first option page", async () => {
		const first = Array.from({ length: 50 }, (_, i) =>
			project({ id: `prj_${i + 2}`, name: `Project ${i + 2}` }),
		);
		server.use(
			http.get(apiUrl("/projects"), ({ request }) => {
				const url = new URL(request.url);
				if (url.searchParams.get("cursor") === "c1") {
					return HttpResponse.json({
						data: [project({ id: "prj_far", name: "Faraway Project" })],
						next_cursor: null,
					});
				}
				return HttpResponse.json({ data: first, next_cursor: "c1" });
			}),
			http.get(apiUrl("/destinations"), () =>
				HttpResponse.json({ data: [destination()], next_cursor: null }),
			),
			http.post(apiUrl("/sources"), async ({ request }) => {
				const body = (await request.json()) as Record<string, unknown>;
				return HttpResponse.json(source(body as object), { status: 201 });
			}),
		);
		const { user } = await wrap(<SourceFormDialog open onOpenChange={() => {}} />);
		await user.click(screen.getByRole("combobox", { name: "Project" }));
		expect(
			screen.queryByRole("option", { name: "Faraway Project" }),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Load more" }));
		await user.click(
			await screen.findByRole("option", { name: "Faraway Project" }),
		);
		expect(
			screen.getByRole("combobox", { name: "Project" }),
		).toHaveTextContent("Faraway Project");
	});

	it("clears the destination when the project changes", async () => {
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({
					data: [project(), project({ id: "prj_2", name: "Other" })],
					next_cursor: null,
				}),
			),
			http.get(apiUrl("/destinations"), ({ request }) => {
				const url = new URL(request.url);
				const pid = url.searchParams.get("project_id");
				return HttpResponse.json({
					data:
						pid === "prj_2"
							? [destination({ id: "dst_2", name: "Other API" })]
							: [destination()],
					next_cursor: null,
				});
			}),
		);
		const { user } = await wrap(<SourceFormDialog open onOpenChange={() => {}} />);
		await user.click(screen.getByRole("combobox", { name: "Project" }));
		await user.click(await screen.findByRole("option", { name: "Payments" }));
		await user.click(screen.getByRole("combobox", { name: "Destination" }));
		await user.click(
			await screen.findByRole("option", { name: "Billing API" }),
		);
		expect(
			screen.getByRole("combobox", { name: "Destination" }),
		).toHaveTextContent("Billing API");
		await user.click(screen.getByRole("combobox", { name: "Project" }));
		await user.click(await screen.findByRole("option", { name: "Other" }));
		expect(
			screen.getByRole("combobox", { name: "Destination" }),
		).toHaveTextContent("Select destination");
	});

	it("keeps every HMAC, dedup, and size input in the create body", async () => {
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
				return HttpResponse.json(source({ auth_type: "hmac" }), {
					status: 201,
				});
			}),
		);
		const { user } = await wrap(<SourceFormDialog open onOpenChange={() => {}} />);
		await user.click(screen.getByRole("combobox", { name: "Project" }));
		await user.click(await screen.findByRole("option", { name: "Payments" }));
		await user.click(screen.getByRole("combobox", { name: "Destination" }));
		await user.click(
			await screen.findByRole("option", { name: "Billing API" }),
		);
		await user.type(screen.getByLabelText("Name"), "Stripe");
		await user.click(screen.getByRole("combobox", { name: "Auth type" }));
		await user.click(
			await screen.findByRole("option", { name: "HMAC signature" }),
		);
		await user.type(screen.getByLabelText("Signature header"), "X-Sig");
		await user.type(screen.getByLabelText("Prefix (optional)"), "sha256=");
		await user.click(screen.getByRole("combobox", { name: "Algorithm" }));
		await user.click(await screen.findByRole("option", { name: "SHA-512" }));
		await user.type(screen.getByLabelText(/^Secret/), "a-very-long-shared-secret-value");
		await user.click(screen.getByRole("combobox", { name: "Event ID from" }));
		await user.click(await screen.findByRole("option", { name: "Header" }));
		await user.type(screen.getByLabelText("Header name"), "X-Event-Id");
		await user.type(screen.getByLabelText(/Max body bytes/), "65536");
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() => expect(body).toBeDefined());
		expect(body).toMatchObject({
			auth_type: "hmac",
			auth_config: {
				header: "X-Sig",
				prefix: "sha256=",
				algorithm: "sha512",
				encoding: "hex",
			},
			secret: "a-very-long-shared-secret-value",
			event_id_from: "header",
			event_id_selector: "X-Event-Id",
			max_body_bytes: 65536,
		});
	});

	it("tells the operator that source changes take up to 30 seconds", async () => {
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({ data: [project()], next_cursor: null }),
			),
			http.get(apiUrl("/destinations"), () =>
				HttpResponse.json({ data: [destination()], next_cursor: null }),
			),
		);
		await wrap(<SourceFormDialog open onOpenChange={() => {}} />);
		expect(
			await screen.findByText(/up to 30 seconds/i),
		).toBeInTheDocument();
	});

	it("blocks an accidental cancel and keeps the edits", async () => {
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({ data: [project()], next_cursor: null }),
			),
			http.get(apiUrl("/destinations"), () =>
				HttpResponse.json({ data: [destination()], next_cursor: null }),
			),
		);
		const { user } = await wrap(<SourceFormDialog open onOpenChange={() => {}} />);
		await user.type(await screen.findByLabelText("Name"), "Stripe");
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(
			await screen.findByRole("heading", { name: /discard/i }),
		).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: "Keep editing" }),
		);
		expect(screen.getByLabelText("Name")).toHaveValue("Stripe");
		expect(
			screen.queryByRole("heading", { name: /discard/i }),
		).not.toBeInTheDocument();
	});
});
