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
});
