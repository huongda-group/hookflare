import type { Overview } from "@hookflare/shared";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OverviewAttention } from "@/components/OverviewAttention";
import { T } from "../helpers/fixtures";

const overview = (o: Partial<Overview> = {}): Overview => ({
	range: "24h",
	from: T - 86_400_000,
	to: T,
	generated_at: T,
	totals: {
		received: 0,
		delivered: 0,
		failed_final: 0,
		dead: 0,
		attempts: 0,
		success_rate: null,
	},
	live: {} as Overview["live"],
	trend: [],
	failing_destinations: [],
	open_alerts: { count: 0, by_rule: {} },
	...o,
});

async function renderAttention(props: Parameters<typeof OverviewAttention>[0]) {
	const rootRoute = createRootRoute({
		component: () => <OverviewAttention {...props} />,
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	await router.load();
	render(<RouterProvider router={router} />);
}

describe("OverviewAttention", () => {
	it("links a single alert and an unnamed destination across all projects", async () => {
		await renderAttention({
			overview: overview({
				open_alerts: { count: 1, by_rule: { new_dead: 1 } },
				failing_destinations: [
					{ destination_id: "dst_9", name: null, failed: 3, delivered: 7 },
				],
			}),
		});
		const alerts = await screen.findByRole("link", { name: "1 open alert" });
		expect(alerts.getAttribute("href")).toBe("/alerts?status=open");
		const investigate = screen.getByRole("link", {
			name: "Investigate dst_9",
		});
		expect(investigate.getAttribute("href")).toContain("destination_id=dst_9");
		expect(investigate.getAttribute("href")).not.toContain("project_id");
		expect(screen.getByRole("link", { name: "dst_9" })).toBeInTheDocument();
		expect(screen.getByText(/3 failed · 7 delivered/)).toBeInTheDocument();
	});

	it("scopes links to the project and counts several alerts", async () => {
		await renderAttention({
			projectId: "prj_1",
			overview: overview({
				open_alerts: { count: 2, by_rule: {} },
				failing_destinations: [
					{
						destination_id: "dst_1",
						name: "Billing API",
						failed: 1,
						delivered: 0,
					},
				],
			}),
		});
		const alerts = await screen.findByRole("link", { name: "2 open alerts" });
		expect(alerts.getAttribute("href")).toContain("project_id=prj_1");
		expect(
			screen
				.getByRole("link", { name: "Investigate Billing API" })
				.getAttribute("href"),
		).toContain("project_id=prj_1");
	});

	it("points at open alerts when no destination is failing", async () => {
		await renderAttention({
			overview: overview({ open_alerts: { count: 4, by_rule: {} } }),
		});
		expect(
			await screen.findByText(/No destination failures in the selected period/),
		).toHaveTextContent("Review open alerts above.");
	});

	it("reports a quiet snapshot", async () => {
		await renderAttention({ overview: overview() });
		expect(
			await screen.findByText(/No open alerts in this snapshot/),
		).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
