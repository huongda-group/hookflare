import type { Overview } from "@hookflare/shared";
import { screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { eventSummary, T } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

const H = 3_600_000;
const overview = (o: Partial<Overview> = {}): Overview => ({
	range: "24h",
	from: T - 23 * H,
	to: T + H,
	generated_at: T,
	totals: {
		received: 120,
		delivered: 100,
		failed_final: 3,
		dead: 2,
		attempts: 140,
		success_rate: 100 / 105,
	},
	live: { pending: 0, queued: 1, in_flight: 0, retrying: 4, paused: 2 },
	trend: Array.from({ length: 24 }, (_, i) => ({
		hour: T - (23 - i) * H,
		received: 5,
		delivered: 4,
		failed: 0,
	})),
	failing_destinations: [
		{ destination_id: "dst_1", name: "Billing API", failed: 5, delivered: 50 },
	],
	open_alerts: { count: 0, by_rule: {} },
	...o,
});

describe("Overview", () => {
	it("shows totals, live counts, failing destinations, and recent events", async () => {
		server.use(
			http.get(apiUrl("/overview"), () => HttpResponse.json(overview())),
			http.get(apiUrl("/events"), () =>
				HttpResponse.json({ data: [eventSummary()], next_cursor: null }),
			),
		);
		renderApp("/");
		const tile = async (label: string) =>
			within(
				(await screen.findByText(label)).closest("[data-tile]") as HTMLElement,
			);
		expect((await tile("Received")).getByText("120")).toBeInTheDocument();
		expect((await tile("Success rate")).getByText("95.2%")).toBeInTheDocument();
		expect((await tile("Retrying")).getByText("4")).toBeInTheDocument();
		expect((await tile("Dead")).getByText("2")).toBeInTheDocument();
		const link = screen.getByRole("link", { name: "Billing API" });
		expect(link).toHaveAttribute("href", expect.stringContaining("/failures?"));
		expect(link.getAttribute("href")).toContain("destination_id=dst_1");
		expect(await screen.findByText("evt_1")).toBeInTheDocument();
		expect(screen.getByText(/updated every 5 minutes/i)).toBeInTheDocument();
	});

	it("shows — for a null success rate", async () => {
		server.use(
			http.get(apiUrl("/overview"), () =>
				HttpResponse.json(
					overview({
						totals: {
							received: 0,
							delivered: 0,
							failed_final: 0,
							dead: 0,
							attempts: 0,
							success_rate: null,
						},
					}),
				),
			),
		);
		renderApp("/");
		const tile = within(
			(await screen.findByText("Success rate")).closest(
				"[data-tile]",
			) as HTMLElement,
		);
		expect(tile.getByText("—")).toBeInTheDocument();
	});

	it("passes range and project from the URL to the API", async () => {
		let seen = "";
		server.use(
			http.get(apiUrl("/overview"), ({ request }) => {
				seen = new URL(request.url).search;
				return HttpResponse.json(overview({ range: "7d" }));
			}),
		);
		renderApp("/?range=7d&project_id=prj_1");
		await screen.findByText("Received");
		expect(seen).toContain("range=7d");
		expect(seen).toContain("project_id=prj_1");
	});

	it("shows a banner linking to open alerts only when some are open", async () => {
		server.use(
			http.get(apiUrl("/overview"), () =>
				HttpResponse.json(
					overview({ open_alerts: { count: 2, by_rule: { new_dead: 2 } } }),
				),
			),
		);
		renderApp("/");
		const banner = await screen.findByRole("alert");
		expect(banner).toHaveTextContent("2 open alerts");
		expect(within(banner).getByRole("link")).toHaveAttribute(
			"href",
			"/alerts?status=open",
		);
	});

	it("shows no banner when nothing is open", async () => {
		server.use(
			http.get(apiUrl("/overview"), () => HttpResponse.json(overview())),
		);
		renderApp("/");
		await screen.findByText("Billing API");
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
