import { screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { alert } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

describe("Alerts page", () => {
	it("lists incidents and filters by status via the URL", async () => {
		const seen: string[] = [];
		server.use(
			http.get(apiUrl("/alerts"), ({ request }) => {
				seen.push(new URL(request.url).search);
				return HttpResponse.json({
					data: [
						alert(),
						alert({
							id: "alr_2",
							status: "resolved",
							resolved_at: Date.now(),
							resource_name: "Search API",
						}),
					],
					next_cursor: null,
				});
			}),
		);
		renderApp("/alerts?status=open");
		expect(await screen.findByText("Billing API")).toBeInTheDocument();
		expect(seen.at(-1)).toContain("status=open");
	});

	it("shows details, dead delivery links, and the notification log", async () => {
		server.use(
			http.get(apiUrl("/alerts/alr_9"), () =>
				HttpResponse.json({
					...alert({
						id: "alr_9",
						rule: "new_dead",
						details: { new_dead: 2, delivery_ids: ["dlv_a", "dlv_b"] },
					}),
					notifications: [
						{
							id: "ant_1",
							channel_id: "ach_1",
							channel_name: "ops",
							kind: "opened",
							status: "failed",
							tries: 3,
							last_error: "HTTP 500",
							created_at: Date.now(),
							sent_at: null,
						},
					],
				}),
			),
		);
		renderApp("/alerts/alr_9");
		expect(await screen.findByText("new_dead")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "dlv_a" })).toBeInTheDocument();
		const log = screen.getByRole("table", { name: /notifications/i });
		expect(within(log).getByText("HTTP 500")).toBeInTheDocument();
	});
});
