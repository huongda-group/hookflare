import type { Overview } from "@hookflare/shared";
import { screen, waitFor, within } from "@testing-library/react";
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
		expect((await tile("Events received")).getByText("120")).toBeInTheDocument();
		expect(
			(await tile("Delivery success rate")).getByText("95.2%"),
		).toBeInTheDocument();
		expect((await tile("Retrying")).getByText("4")).toBeInTheDocument();
		const terminalEl = (await screen.findByText("Terminal failures")).closest(
			"[data-tile]",
		) as HTMLElement;
		const terminal = within(terminalEl);
		expect(terminal.getByText("5")).toBeInTheDocument();
		expect(terminalEl).toHaveTextContent(/Failed final\D*3/);
		expect(terminalEl).toHaveTextContent(/Dead letter\D*2/);
		const link = screen.getByRole("link", { name: "Billing API" });
		expect(link).toHaveAttribute("href", expect.stringContaining("/failures?"));
		expect(link.getAttribute("href")).toContain("destination_id=dst_1");
		expect(await screen.findByText("evt_1")).toBeInTheDocument();
		expect(screen.getByText(/five-minute rollup/i)).toBeInTheDocument();
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
			(await screen.findByText("Delivery success rate")).closest(
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

describe("Overview redesign (spec §8.3)", () => {
	it("orders sections: reporting, traffic, live states, failing, recent", async () => {
		server.use(
			http.get(apiUrl("/overview"), () => HttpResponse.json(overview())),
			http.get(apiUrl("/events"), () =>
				HttpResponse.json({ data: [eventSummary()], next_cursor: null }),
			),
		);
		renderApp("/");
		await screen.findByText("evt_1");
		const names = [
			"Reporting",
			"Traffic",
			"Current delivery states",
			"Failing destinations",
			"Recent events",
		];
		const heads = names.map((n) =>
			screen.getByRole("heading", { name: n }),
		);
		for (let i = 1; i < heads.length; i++)
			expect(
				heads[i - 1].compareDocumentPosition(heads[i]) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
	});

	it("groups pending live states and marks them independent of the range", async () => {
		server.use(
			http.get(apiUrl("/overview"), () =>
				HttpResponse.json(
					overview({
						live: { pending: 1, queued: 2, in_flight: 3, retrying: 4, paused: 2 },
					}),
				),
			),
			http.get(apiUrl("/events"), () =>
				HttpResponse.json({ data: [], next_cursor: null }),
			),
		);
		renderApp("/?range=24h");
		const tile = within(
			(await screen.findByText("Pending")).closest(
				"[data-tile]",
			) as HTMLElement,
		);
		expect(tile.getByText("6")).toBeInTheDocument();
		expect(
			screen.getByText(/pending, queued, and in flight/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(/independent of the selected reporting period/i),
		).toBeInTheDocument();
	});

	it("links failing destinations with project, destination, and time scope", async () => {
		server.use(
			http.get(apiUrl("/overview"), () => HttpResponse.json(overview())),
			http.get(apiUrl("/events"), () =>
				HttpResponse.json({ data: [], next_cursor: null }),
			),
		);
		renderApp("/?project_id=prj_1");
		const link = await screen.findByRole("link", { name: "Billing API" });
		const href = link.getAttribute("href") ?? "";
		expect(href).toContain("/failures?");
		expect(href).toContain("destination_id=dst_1");
		expect(href).toContain("project_id=prj_1");
		expect(href).toContain(`from=${overview().from}`);
		expect(href).toContain(`to=${overview().to}`);
	});

	it("labels generated_at as API query time, not rollup execution", async () => {
		server.use(
			http.get(apiUrl("/overview"), () => HttpResponse.json(overview())),
			http.get(apiUrl("/events"), () =>
				HttpResponse.json({ data: [], next_cursor: null }),
			),
		);
		renderApp("/");
		expect(
			await screen.findByText(/api response generation time/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/rollup completion/i)).toBeNull();
	});

	it("summarizes the traffic trend as accessible text, not color alone", async () => {
		server.use(
			http.get(apiUrl("/overview"), () => HttpResponse.json(overview())),
			http.get(apiUrl("/events"), () =>
				HttpResponse.json({ data: [], next_cursor: null }),
			),
		);
		renderApp("/");
		const table = await screen.findByRole("table", {
			name: /traffic trend/i,
		});
		expect(
			within(table).getByRole("columnheader", { name: "Received" }),
		).toBeInTheDocument();
		expect(
			within(table).getByRole("columnheader", { name: "Delivered" }),
		).toBeInTheDocument();
		expect(
			within(table).getByRole("columnheader", { name: "Failed" }),
		).toBeInTheDocument();
	});

	it("shows an onboarding empty state instead of an activity-implying chart", async () => {
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
						trend: [],
						failing_destinations: [],
					}),
				),
			),
			http.get(apiUrl("/events"), () =>
				HttpResponse.json({ data: [], next_cursor: null }),
			),
		);
		renderApp("/");
		expect(
			await screen.findByText(/No events received in this reporting range/),
		).toBeInTheDocument();
		expect(screen.queryByLabelText("Event trend")).toBeNull();
	});

	it("never replaces the current project with a slow older-project response", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let oldStarted = false;
		const totalsFor = (received: number) => ({
			received,
			delivered: received,
			failed_final: 0,
			dead: 0,
			attempts: received,
			success_rate: 1,
		});
		server.use(
			http.get(apiUrl("/overview"), async ({ request }) => {
				if (
					new URL(request.url).searchParams.get("project_id") === "prj_old"
				) {
					oldStarted = true;
					await gate;
					return HttpResponse.json(
						overview({ totals: totalsFor(111), trend: [] }),
					);
				}
				return HttpResponse.json(overview({ totals: totalsFor(999), trend: [] }));
			}),
			http.get(apiUrl("/events"), () =>
				HttpResponse.json({ data: [], next_cursor: null }),
			),
		);
		const { router } = renderApp("/?project_id=prj_old&range=24h");
		await waitFor(() => expect(oldStarted).toBe(true));
		await router.navigate({
			to: "/",
			search: { project_id: "prj_new", range: "24h" },
		});
		release();
		const tileEl = (await screen.findByText("Events received")).closest(
			"[data-tile]",
		) as HTMLElement;
		const tile = within(tileEl);
		await waitFor(() => expect(tileEl).toHaveTextContent("999"), {
			timeout: 5000,
		});
		expect(tile.queryByText("111")).toBeNull();
	});
});
