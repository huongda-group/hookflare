import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createGate } from "../../helpers/gate";
import { renderApp } from "../../helpers/render";
import { apiUrl, server } from "../../helpers/server";

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
		const { router } = renderApp("/settings?tab=alerts");
		const field = await screen.findByLabelText("Failure threshold");
		await user.clear(field);
		await user.type(field, "7");
		await user.click(screen.getByRole("button", { name: "Save rules" }));
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0]).toMatchObject({ alert_rules: { failure_threshold: 7 } });
		expect(bodies[0]).not.toHaveProperty("retry_defaults");
		await user.click(screen.getByRole("link", { name: "Projects" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/projects"),
		);
		expect(
			screen.queryByRole("heading", { name: "Discard unsaved changes?" }),
		).not.toBeInTheDocument();
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
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/projects"),
		);
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
		await user.click(
			await screen.findByRole("button", { name: "Add channel" }),
		);
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
	it("shows a server error under the rules form and no saved notice", async () => {
		server.use(
			http.patch(apiUrl("/settings"), () =>
				HttpResponse.json({ error: "settings_locked" }, { status: 409 }),
			),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=alerts");
		const field = await screen.findByLabelText("Failure threshold");
		await user.clear(field);
		await user.type(field, "7");
		await user.click(screen.getByRole("button", { name: "Save rules" }));
		expect(
			await screen.findByText("settings_locked", {
				selector: "[data-field-error]",
			}),
		).toBeInTheDocument();
		expect(screen.queryByText(/applies within about a minute/i)).toBeNull();
	});

	it("shows saved feedback after rules are accepted", async () => {
		server.use(http.patch(apiUrl("/settings"), () => HttpResponse.json({})));
		const user = userEvent.setup();
		renderApp("/settings?tab=alerts");
		const field = await screen.findByLabelText("Failure threshold");
		await user.clear(field);
		await user.type(field, "7");
		await user.click(screen.getByRole("button", { name: "Save rules" }));
		expect(
			await screen.findByText(/applies within about a minute/i),
		).toBeInTheDocument();
	});

	it("lists a disabled, scoped Telegram channel and re-enables it", async () => {
		const patched: unknown[] = [];
		server.use(
			http.get(apiUrl("/alert-channels"), () =>
				HttpResponse.json({
					data: [
						{
							...channel,
							type: "telegram",
							enabled: false,
							chat_id: "-100123",
							rules: ["new_dead", "stuck_pending"],
							project_ids: ["prj_1", "prj_2"],
						},
					],
				}),
			),
			http.patch(apiUrl("/alert-channels/ach_1"), async ({ request }) => {
				patched.push(await request.json());
				return HttpResponse.json(channel);
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=alerts");
		const row = (await screen.findByText("ops (disabled)")).closest(
			"tr",
		) as HTMLElement;
		expect(within(row).getByText("telegram · -100123")).toBeInTheDocument();
		expect(
			within(row).getByText("new_dead, stuck_pending"),
		).toBeInTheDocument();
		expect(within(row).getByText("2")).toBeInTheDocument();
		await user.click(within(row).getByRole("button", { name: "Enable" }));
		await waitFor(() => expect(patched).toEqual([{ enabled: true }]));
	});

	it("reports a successful test send", async () => {
		server.use(
			http.get(apiUrl("/alert-channels"), () =>
				HttpResponse.json({ data: [channel] }),
			),
			http.post(apiUrl("/alert-channels/ach_1/test"), () =>
				HttpResponse.json({ ok: true }),
			),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=alerts");
		const row = (await screen.findByText("ops")).closest("tr") as HTMLElement;
		expect(within(row).getAllByText("All")).toHaveLength(2);
		await user.click(within(row).getByRole("button", { name: "Send test" }));
		expect(await within(row).findByText("Sent")).toBeInTheDocument();
	});

	it("creates a channel, closes the dialog, and refetches the list", async () => {
		const created: unknown[] = [];
		let channels: (typeof channel)[] = [];
		server.use(
			http.get(apiUrl("/alert-channels"), () =>
				HttpResponse.json({ data: channels }),
			),
			http.post(apiUrl("/alert-channels"), async ({ request }) => {
				created.push(await request.json());
				channels = [{ ...channel, name: "pager" }];
				return HttpResponse.json(channels[0], { status: 201 });
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=alerts");
		await user.click(
			await screen.findByRole("button", { name: "Add channel" }),
		);
		await user.type(screen.getByLabelText("Name"), "pager");
		await user.type(
			screen.getByLabelText("Webhook URL"),
			"https://discord.com/api/webhooks/1/abc",
		);
		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText("pager")).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "Add channel" }),
		).not.toBeInTheDocument();
		expect(created).toEqual([
			expect.objectContaining({
				name: "pager",
				config: {
					type: "discord",
					url: "https://discord.com/api/webhooks/1/abc",
				},
			}),
		]);
	});

	it("closes the channel dialog and the delete confirmation without changes", async () => {
		let deleted = false;
		server.use(
			http.get(apiUrl("/alert-channels"), () =>
				HttpResponse.json({ data: [channel] }),
			),
			http.delete(apiUrl("/alert-channels/ach_1"), () => {
				deleted = true;
				return new HttpResponse(null, { status: 204 });
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=alerts");
		const row = (await screen.findByText("ops")).closest("tr") as HTMLElement;
		await user.click(within(row).getByRole("button", { name: "Edit" }));
		await screen.findByRole("heading", { name: "Edit channel" });
		await user.keyboard("{Escape}");
		await waitFor(() =>
			expect(
				screen.queryByRole("heading", { name: "Edit channel" }),
			).not.toBeInTheDocument(),
		);
		await user.click(within(row).getByRole("button", { name: "Delete" }));
		await screen.findByRole("heading", { name: "Delete ops?" });
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(
				screen.queryByRole("heading", { name: "Delete ops?" }),
			).not.toBeInTheDocument(),
		);
		expect(deleted).toBe(false);
	});

	it("shows a load error, not an empty list, when channels fail to load", async () => {
		let calls = 0;
		server.use(
			http.get(apiUrl("/alert-channels"), () => {
				calls += 1;
				return calls === 1
					? HttpResponse.json({ error: "internal" }, { status: 500 })
					: HttpResponse.json({ data: [channel] });
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=alerts");
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/could not load this list/i);
		expect(screen.queryByText(/channel\(s\)/)).not.toBeInTheDocument();
		await user.click(within(alert).getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("ops")).toBeInTheDocument();
		expect(screen.getByText("1 channel(s)")).toBeInTheDocument();
	});

	it("shows a loading state while channels load", async () => {
		const gate = createGate();
		server.use(
			http.get(apiUrl("/alert-channels"), async () => {
				await gate.wait();
				return HttpResponse.json({ data: [channel] });
			}),
		);
		renderApp("/settings?tab=alerts");
		expect(
			await screen.findByRole("status", { name: "Loading" }),
		).toBeInTheDocument();
		expect(screen.queryByText(/channel\(s\)/)).not.toBeInTheDocument();
		gate.release();
		expect(await screen.findByText("1 channel(s)")).toBeInTheDocument();
	});

	it("sends the typed delete reason, and no body without one", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.get(apiUrl("/alert-channels"), () =>
				HttpResponse.json({ data: [channel] }),
			),
			http.delete(apiUrl("/alert-channels/ach_1"), async ({ request }) => {
				const text = await request.text();
				bodies.push(text ? JSON.parse(text) : undefined);
				return new HttpResponse(null, { status: 204 });
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=alerts");
		const row = (await screen.findByText("ops")).closest("tr") as HTMLElement;
		await user.click(within(row).getByRole("button", { name: "Delete" }));
		await user.type(
			await screen.findByLabelText("Reason (optional)"),
			"retired webhook",
		);
		await user.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(bodies).toHaveLength(1));
		await waitFor(() =>
			expect(
				screen.queryByRole("heading", { name: "Delete ops?" }),
			).not.toBeInTheDocument(),
		);
		await user.click(within(row).getByRole("button", { name: "Delete" }));
		await screen.findByRole("heading", { name: "Delete ops?" });
		await user.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(bodies).toHaveLength(2));
		expect(bodies).toEqual([{ reason: "retired webhook" }, undefined]);
	});
});
