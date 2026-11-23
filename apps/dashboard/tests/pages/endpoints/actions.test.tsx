import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { destination, source } from "../../helpers/fixtures";
import { renderApp } from "../../helpers/render";
import { apiUrl, server } from "../../helpers/server";

const SOURCE = "/endpoints/sources/src_1";
const DESTINATION = "/endpoints/destinations/dst_1";

describe("Source actions", () => {
	it("are hidden from operators without config.write", async () => {
		server.use(
			http.get(apiUrl("/sources/src_1"), () => HttpResponse.json(source())),
		);
		renderApp(SOURCE, { role: "operator" });
		await screen.findByRole("heading", { name: "Stripe" });
		expect(
			screen.queryByRole("button", { name: "Actions" }),
		).not.toBeInTheDocument();
	});

	it("re-enables a disabled source with the given reason", async () => {
		const patches: unknown[] = [];
		server.use(
			http.get(apiUrl("/sources/src_1"), () =>
				HttpResponse.json(source({ status: "disabled" })),
			),
			http.patch(apiUrl("/sources/src_1"), async ({ request }) => {
				patches.push({
					scope: new URL(request.url).searchParams.get("project_id"),
					body: await request.json(),
				});
				return HttpResponse.json(source());
			}),
		);
		const { user } = renderApp(SOURCE);
		await screen.findByRole("heading", { name: "Stripe" });
		await user.click(screen.getByRole("button", { name: "Actions" }));
		expect(
			screen.queryByRole("menuitem", { name: "Disable" }),
		).not.toBeInTheDocument();
		await user.click(await screen.findByRole("menuitem", { name: "Enable" }));
		const dialog = within(
			await screen.findByRole("dialog", { name: "Enable Stripe?" }),
		);
		expect(
			dialog.getByText("Ingress accepts events again."),
		).toBeInTheDocument();
		await user.type(dialog.getByLabelText("Reason (optional)"), "fixed");
		await user.click(dialog.getByRole("button", { name: "Enable" }));
		await waitFor(() =>
			expect(patches).toEqual([
				{ scope: "prj_1", body: { status: "active", reason: "fixed" } },
			]),
		);
	});

	it("omits Rotate secret for unauthenticated sources", async () => {
		server.use(
			http.get(apiUrl("/sources/src_1"), () =>
				HttpResponse.json(source({ auth_type: "none", auth_config: {} })),
			),
		);
		const { user } = renderApp(SOURCE);
		await screen.findByRole("heading", { name: "Stripe" });
		await user.click(screen.getByRole("button", { name: "Actions" }));
		expect(
			await screen.findByRole("menuitem", { name: "Edit" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("menuitem", { name: "Rotate secret" }),
		).not.toBeInTheDocument();
	});

	it("opens the edit form prefilled with the source", async () => {
		server.use(
			http.get(apiUrl("/sources/src_1"), () => HttpResponse.json(source())),
		);
		const { user } = renderApp(SOURCE);
		await screen.findByRole("heading", { name: "Stripe" });
		await user.click(screen.getByRole("button", { name: "Actions" }));
		await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
		const dialog = within(
			await screen.findByRole("dialog", { name: "Edit source" }),
		);
		expect(dialog.getByLabelText("Name")).toHaveValue("Stripe");
		await user.click(dialog.getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});

	it("rotates the secret, reveals it once, then forgets it", async () => {
		const rotations: unknown[] = [];
		server.use(
			http.get(apiUrl("/sources/src_1"), () => HttpResponse.json(source())),
			http.post(apiUrl("/sources/src_1/rotate-secret"), async ({ request }) => {
				rotations.push(new URL(request.url).searchParams.get("project_id"));
				return HttpResponse.json({ id: "src_1", secret: "shh_rotated" });
			}),
		);
		const { user } = renderApp(SOURCE);
		await screen.findByRole("heading", { name: "Stripe" });
		await user.click(screen.getByRole("button", { name: "Actions" }));
		await user.click(
			await screen.findByRole("menuitem", { name: "Rotate secret" }),
		);
		await user.click(await screen.findByRole("button", { name: "Rotate" }));
		expect(await screen.findByText("shh_rotated")).toBeInTheDocument();
		expect(rotations).toEqual(["prj_1"]);
		await user.click(screen.getByLabelText("I have stored this secret"));
		await user.click(screen.getByRole("button", { name: "Done" }));
		await waitFor(() =>
			expect(screen.queryByText("shh_rotated")).not.toBeInTheDocument(),
		);
	});

	it("opens the menu from the keyboard without leaving the list", async () => {
		server.use(
			http.get(apiUrl("/sources"), () =>
				HttpResponse.json({ data: [source()], next_cursor: null }),
			),
		);
		const { user, router } = renderApp("/endpoints?tab=sources");
		const row = (await screen.findByRole("link", { name: "Stripe" })).closest(
			"tr",
		) as HTMLElement;
		within(row).getByRole("button", { name: "Actions" }).focus();
		await user.keyboard("{Enter}");
		expect(
			await screen.findByRole("menuitem", { name: "Disable" }),
		).toBeInTheDocument();
		expect(router.state.location.pathname).toBe("/endpoints");
	});
});

describe("Destination actions", () => {
	it("disables the destination with the given reason", async () => {
		const patches: unknown[] = [];
		server.use(
			http.get(apiUrl("/destinations/dst_1"), () =>
				HttpResponse.json(destination()),
			),
			http.patch(apiUrl("/destinations/dst_1"), async ({ request }) => {
				patches.push({
					scope: new URL(request.url).searchParams.get("project_id"),
					body: await request.json(),
				});
				return HttpResponse.json(destination({ status: "disabled" }));
			}),
		);
		const { user } = renderApp(DESTINATION);
		await screen.findByRole("heading", { name: "Billing API" });
		await user.click(screen.getByRole("button", { name: "Actions" }));
		await user.click(await screen.findByRole("menuitem", { name: "Disable" }));
		const dialog = within(
			await screen.findByRole("dialog", { name: "Disable Billing API?" }),
		);
		expect(dialog.getByText(/are not attempted/i)).toBeInTheDocument();
		await user.type(dialog.getByLabelText("Reason (optional)"), "retired");
		await user.click(dialog.getByRole("button", { name: "Disable" }));
		await waitFor(() =>
			expect(patches).toEqual([
				{ scope: "prj_1", body: { status: "disabled", reason: "retired" } },
			]),
		);
	});

	it("re-enables a disabled destination with the given reason and offers neither Pause, Resume nor Disable", async () => {
		const patches: unknown[] = [];
		server.use(
			http.get(apiUrl("/destinations/dst_1"), () =>
				HttpResponse.json(destination({ status: "disabled" })),
			),
			http.patch(apiUrl("/destinations/dst_1"), async ({ request }) => {
				patches.push({
					scope: new URL(request.url).searchParams.get("project_id"),
					body: await request.json(),
				});
				return HttpResponse.json(destination());
			}),
		);
		const { user } = renderApp(DESTINATION);
		await screen.findByRole("heading", { name: "Billing API" });
		await user.click(screen.getByRole("button", { name: "Actions" }));
		expect(
			await screen.findByRole("menuitem", { name: "Edit" }),
		).toBeInTheDocument();
		for (const name of ["Pause", "Resume", "Disable"])
			expect(screen.queryByRole("menuitem", { name })).not.toBeInTheDocument();
		await user.click(screen.getByRole("menuitem", { name: "Enable" }));
		const dialog = within(
			await screen.findByRole("dialog", { name: "Enable Billing API?" }),
		);
		expect(dialog.getByText(/replay them from Failures/)).toBeInTheDocument();
		await user.type(dialog.getByLabelText("Reason (optional)"), "back");
		await user.click(dialog.getByRole("button", { name: "Enable" }));
		await waitFor(() =>
			expect(patches).toEqual([
				{ scope: "prj_1", body: { status: "active", reason: "back" } },
			]),
		);
	});

	it("offers no Enable on an active destination", async () => {
		server.use(
			http.get(apiUrl("/destinations/dst_1"), () =>
				HttpResponse.json(destination()),
			),
		);
		const { user } = renderApp(DESTINATION);
		await screen.findByRole("heading", { name: "Billing API" });
		await user.click(screen.getByRole("button", { name: "Actions" }));
		expect(
			await screen.findByRole("menuitem", { name: "Disable" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("menuitem", { name: "Enable" }),
		).not.toBeInTheDocument();
	});

	it("opens the menu from the keyboard without leaving the list", async () => {
		server.use(
			http.get(apiUrl("/destinations"), () =>
				HttpResponse.json({ data: [destination()], next_cursor: null }),
			),
		);
		const { user, router } = renderApp("/endpoints?tab=destinations");
		const row = (
			await screen.findByRole("link", { name: "Billing API" })
		).closest("tr") as HTMLElement;
		within(row).getByRole("button", { name: "Actions" }).focus();
		await user.keyboard("{Enter}");
		expect(
			await screen.findByRole("menuitem", { name: "Pause" }),
		).toBeInTheDocument();
		expect(router.state.location.pathname).toBe("/endpoints");
	});
});
