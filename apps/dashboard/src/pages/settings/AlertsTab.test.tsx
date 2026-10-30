import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

const channel = {
	id: "ach_1",
	name: "ops",
	type: "discord",
	enabled: true,
	rules: [],
	project_ids: [],
	config_fingerprint: "a1b2c3d4",
	chat_id: null,
	created_at: 1,
	updated_at: 1,
};

describe("Settings › Alerts", () => {
	it("saves alert_rules", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.patch(apiUrl("/settings"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json({});
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=alerts");
		const field = await screen.findByLabelText("Failure threshold");
		await user.clear(field);
		await user.type(field, "7");
		await user.click(screen.getByRole("button", { name: "Save rules" }));
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0]).toMatchObject({ alert_rules: { failure_threshold: 7 } });
		expect(bodies[0]).not.toHaveProperty("retry_defaults");
	});

	it("shows the fingerprint, never asks for the old URL, and sends a test", async () => {
		server.use(
			http.get(apiUrl("/alert-channels"), () =>
				HttpResponse.json({ data: [channel] }),
			),
			http.post(apiUrl("/alert-channels/ach_1/test"), () =>
				HttpResponse.json({ ok: false, error: "HTTP 404" }),
			),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=alerts");
		const row = (await screen.findByText("ops")).closest("tr") as HTMLElement;
		expect(within(row).getByText("a1b2c3d4")).toBeInTheDocument();
		await user.click(within(row).getByRole("button", { name: "Send test" }));
		expect(await screen.findByText(/HTTP 404/)).toBeInTheDocument();

		await user.click(within(row).getByRole("button", { name: "Edit" }));
		const url = screen.getByLabelText(/New webhook URL/);
		expect(url).toHaveValue("");
		expect(url).toHaveAttribute("placeholder", "Leave empty to keep a1b2c3d4");
	});

	it("is hidden for operators", async () => {
		renderApp("/settings?tab=alerts", { role: "operator" });
		expect(await screen.findByText("Retry defaults")).toBeInTheDocument();
		expect(screen.queryByRole("tab", { name: "Alerts" })).toBeNull();
	});

	it("rejects a blank rule override inline and never PATCHes", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.patch(apiUrl("/settings"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json({});
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=alerts");
		const field = await screen.findByLabelText("Failure threshold");
		await user.clear(field);
		await user.click(screen.getByRole("button", { name: "Save rules" }));
		expect(
			await screen.findByText(/expected number|received nan|invalid/i, {
				selector: "[data-field-error]",
			}),
		).toBeInTheDocument();
		expect(bodies).toHaveLength(0);
	});

	it("reverts unsaved rule edits back to the server values", async () => {
		const user = userEvent.setup();
		renderApp("/settings?tab=alerts");
		const field = await screen.findByLabelText("Failure threshold");
		expect(field).toHaveValue(5);
		await user.clear(field);
		await user.type(field, "7");
		expect(field).toHaveValue(7);
		await user.click(screen.getByRole("button", { name: "Revert" }));
		expect(field).toHaveValue(5);
	});

	it("guards dirty rule edits on navigation", async () => {
		const user = userEvent.setup();
		const { router } = renderApp("/settings?tab=alerts");
		const field = await screen.findByLabelText("Failure threshold");
		await user.clear(field);
		await user.type(field, "7");
		await user.click(screen.getByRole("link", { name: "Projects" }));
		expect(
			await screen.findByRole("heading", {
				name: "Discard unsaved changes?",
			}),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		await waitFor(() => expect(router.state.location.pathname).toBe("/projects"));
	});

	it("never fetches stored credentials when opening edit", async () => {
		const credentialGets: string[] = [];
		server.use(
			http.get(apiUrl("/alert-channels"), () =>
				HttpResponse.json({ data: [channel] }),
			),
			http.get(apiUrl("/alert-channels/:id"), ({ params }) => {
				credentialGets.push(String(params.id));
				return HttpResponse.json(channel);
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=alerts");
		const row = (await screen.findByText("ops")).closest("tr") as HTMLElement;
		await user.click(within(row).getByRole("button", { name: "Edit" }));
		expect(
			await screen.findByRole("heading", { name: "Edit channel" }),
		).toBeInTheDocument();
		expect(credentialGets).toHaveLength(0);
	});

	it("only offers supported channel types when creating", async () => {
		server.use(
			http.get(apiUrl("/alert-channels"), () =>
				HttpResponse.json({ data: [] }),
			),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=alerts");
		await user.click(await screen.findByRole("button", { name: "Add channel" }));
		const options = Array.from(
			screen.getByLabelText("Type").querySelectorAll("option"),
		).map((o) => o.textContent);
		expect(options.sort()).toEqual(["discord", "slack", "telegram"]);
	});

	it("toggles a channel off and deletes it through the current API", async () => {
		const patched: unknown[] = [];
		let deleted = false;
		server.use(
			http.get(apiUrl("/alert-channels"), () =>
				HttpResponse.json({ data: [channel] }),
			),
			http.patch(apiUrl("/alert-channels/ach_1"), async ({ request }) => {
				patched.push(await request.json());
				return HttpResponse.json(channel);
			}),
			http.delete(apiUrl("/alert-channels/ach_1"), () => {
				deleted = true;
				return new HttpResponse(null, { status: 204 });
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=alerts");
		const row = (await screen.findByText("ops")).closest("tr") as HTMLElement;
		await user.click(within(row).getByRole("button", { name: "Disable" }));
		await waitFor(() => expect(patched).toEqual([{ enabled: false }]));
		await user.click(within(row).getByRole("button", { name: "Delete" }));
		await user.click(await screen.findByRole("button", { name: "Delete" }));
		await waitFor(() => expect(deleted).toBe(true));
	});
});
