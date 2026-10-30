import { screen, within } from "@testing-library/react";
import type { Alert } from "@hookflare/shared";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { alert, T } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

function detail(o: Partial<Alert> = {}, notifications = [
	{
		id: "ant_1",
		channel_id: "ach_1",
		channel_name: "ops",
		kind: "opened",
		status: "failed",
		tries: 3,
		last_error: "HTTP 500",
		created_at: T,
		sent_at: null,
	},
]) {
	return { ...alert(), notifications, ...o };
}

describe("Alert detail", () => {
	it("shows a structured summary with notification outcome fields", async () => {
		server.use(
			http.get(apiUrl("/alerts/alr_9"), () =>
				HttpResponse.json(
					detail({
						id: "alr_9",
						rule: "new_dead",
						details: { new_dead: 2, delivery_ids: ["dlv_a", "dlv_b"] },
					}),
				),
			),
		);
		renderApp("/alerts/alr_9");
		expect(await screen.findByText("new_dead")).toBeInTheDocument();
		for (const label of ["Resource", "Scope", "Opened"]) {
			expect(screen.getByText(label)).toBeInTheDocument();
		}
		expect(
			screen.getByRole("button", { name: /technical details/i }),
		).toBeInTheDocument();
		const log = screen.getByRole("table", { name: /notifications/i });
		for (const header of [
			"Channel",
			"Kind",
			"Status",
			"Tries",
			"Error",
			"Created",
		]) {
			expect(within(log).getByText(header)).toBeInTheDocument();
		}
		expect(within(log).getByText("ops")).toBeInTheDocument();
		expect(within(log).getByText("opened")).toBeInTheDocument();
		expect(within(log).getByText("failed")).toBeInTheDocument();
		expect(within(log).getByText("3")).toBeInTheDocument();
		expect(within(log).getByText("HTTP 500")).toBeInTheDocument();
	});

	it("discloses the raw details behind a disclosure", async () => {
		server.use(
			http.get(apiUrl("/alerts/alr_9"), () =>
				HttpResponse.json(
					detail({
						id: "alr_9",
						rule: "new_dead",
						details: { new_dead: 2, delivery_ids: ["dlv_a"] },
					}),
				),
			),
		);
		const { user } = renderApp("/alerts/alr_9");
		await screen.findByText("new_dead");
		await user.click(
			screen.getByRole("button", { name: /technical details/i }),
		);
		expect(screen.getByRole("list", { name: "JSON" })).toBeInTheDocument();
	});

	it("never invents acknowledge or resolve actions", async () => {
		server.use(
			http.get(apiUrl("/alerts/alr_9"), () =>
				HttpResponse.json(detail()),
			),
		);
		renderApp("/alerts/alr_9");
		await screen.findByText("Billing API");
		expect(
			screen.queryByRole("button", { name: /acknowledge|resolve/i }),
		).not.toBeInTheDocument();
	});

	it("shows system alerts with their project scope", async () => {
		server.use(
			http.get(apiUrl("/alerts/alr_sys"), () =>
				HttpResponse.json(
					detail({
						id: "alr_sys",
						rule: "d1_storage",
						resource_type: "system",
						resource_id: "host-9",
						resource_name: null,
						project_id: "prj_1",
					}),
				),
			),
		);
		renderApp("/alerts/alr_sys");
		expect(await screen.findByText("system / host-9")).toBeInTheDocument();
		expect(screen.getByText("prj_1")).toBeInTheDocument();
	});

	it("links dead deliveries to Failures with only supported filters", async () => {
		server.use(
			http.get(apiUrl("/alerts/alr_9"), () =>
				HttpResponse.json(
					detail({ details: { new_dead: 1, delivery_ids: ["dlv_a"] } }),
				),
			),
		);
		renderApp("/alerts/alr_9");
		const link = await screen.findByRole("link", { name: "dlv_a" });
		const href = link.getAttribute("href") ?? "";
		expect(href).toContain("tab=dead");
		expect(href).not.toContain("delivery_id");
	});

	it("renders an unknown rule as a readable fallback", async () => {
		server.use(
			http.get(apiUrl("/alerts/alr_x"), () =>
				HttpResponse.json(
					detail({ id: "alr_x", rule: "future_rule_xyz" as Alert["rule"] }),
				),
			),
		);
		renderApp("/alerts/alr_x");
		expect(await screen.findByText(/unknown rule/i)).toBeInTheDocument();
		expect(screen.getByText(/future_rule_xyz/)).toBeInTheDocument();
	});

	it("reports a missing alert instead of failing silently", async () => {
		server.use(
			http.get(apiUrl("/alerts/alr_nope"), () =>
				new HttpResponse(null, { status: 404 }),
			),
		);
		renderApp("/alerts/alr_nope");
		expect(
			await screen.findByText(/was not found/i),
		).toBeInTheDocument();
	});
});
