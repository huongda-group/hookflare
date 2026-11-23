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
import { describe, expect, it, vi } from "vitest";
import { SourceFormDialog } from "@/components/SourceFormDialog";
import { createQueryClient } from "@/router";
import { destination, project, source } from "../helpers/fixtures";
import { apiUrl, server } from "../helpers/server";

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
	return {
		user: userEvent.setup(),
		...render(<RouterProvider router={router} />),
	};
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
		const { user } = await wrap(
			<SourceFormDialog open projectId="prj_1" onOpenChange={() => {}} />,
		);
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
			<SourceFormDialog
				open
				projectId="prj_1"
				onOpenChange={() => {}}
				source={source()}
			/>,
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
			<SourceFormDialog
				open
				projectId="prj_1"
				onOpenChange={() => {}}
				source={source()}
			/>,
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
			<SourceFormDialog
				open
				projectId="prj_1"
				onOpenChange={() => {}}
				source={source()}
			/>,
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

	it("offers only destinations in the project's scope", async () => {
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
		const { user } = await wrap(
			<SourceFormDialog open projectId="prj_2" onOpenChange={() => {}} />,
		);
		await user.click(screen.getByRole("combobox", { name: "Destination" }));
		expect(
			await screen.findByRole("option", { name: "Other API" }),
		).toBeVisible();
		expect(
			screen.queryByRole("option", { name: "Billing API" }),
		).not.toBeInTheDocument();
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
		const { user } = await wrap(
			<SourceFormDialog open projectId="prj_1" onOpenChange={() => {}} />,
		);
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
		await user.type(
			screen.getByLabelText(/^Secret/),
			"a-very-long-shared-secret-value",
		);
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
		await wrap(
			<SourceFormDialog open projectId="prj_1" onOpenChange={() => {}} />,
		);
		expect(await screen.findByText(/up to 30 seconds/i)).toBeInTheDocument();
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
		const { user } = await wrap(
			<SourceFormDialog open projectId="prj_1" onOpenChange={() => {}} />,
		);
		await user.type(await screen.findByLabelText("Name"), "Stripe");
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(
			await screen.findByRole("heading", { name: /discard/i }),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Keep editing" }));
		expect(screen.getByLabelText("Name")).toHaveValue("Stripe");
		expect(
			screen.queryByRole("heading", { name: /discard/i }),
		).not.toBeInTheDocument();
	});
	it("sends a token config and keeps a server issue on its field", async () => {
		let body: Record<string, unknown> | undefined;
		server.use(
			http.get(apiUrl("/destinations"), () =>
				HttpResponse.json({ data: [destination()], next_cursor: null }),
			),
			http.post(apiUrl("/sources"), async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return HttpResponse.json(
					{
						error: "validation_failed",
						issues: [{ path: "name", code: "custom", message: "Name taken" }],
					},
					{ status: 422 },
				);
			}),
		);
		const onOpenChange = vi.fn();
		const { user } = await wrap(
			<SourceFormDialog open projectId="prj_1" onOpenChange={onOpenChange} />,
		);
		await user.click(screen.getByRole("combobox", { name: "Destination" }));
		await user.click(
			await screen.findByRole("option", { name: "Billing API" }),
		);
		await user.type(screen.getByLabelText("Name"), "Shopify");
		await user.click(screen.getByRole("combobox", { name: "Auth type" }));
		await user.click(
			await screen.findByRole("option", { name: "Shared token" }),
		);
		await user.click(screen.getByRole("combobox", { name: "Token in" }));
		await user.click(
			await screen.findByRole("option", { name: "Query parameter" }),
		);
		// The token's own "Name" field follows the source name.
		await user.type(screen.getAllByLabelText("Name")[1], "token");
		await user.type(
			screen.getByLabelText(/^Secret/),
			"a-very-long-shared-secret-value",
		);
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(await screen.findByText("Name taken")).toBeInTheDocument();
		expect(body).toMatchObject({
			auth_type: "token",
			auth_config: { in: "query", name: "token" },
		});
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("closes a clean form on Escape without a prompt", async () => {
		const onOpenChange = vi.fn();
		const { user } = await wrap(
			<SourceFormDialog open projectId="prj_1" onOpenChange={onOpenChange} />,
		);
		await screen.findByRole("dialog");
		await user.keyboard("{Escape}");
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
