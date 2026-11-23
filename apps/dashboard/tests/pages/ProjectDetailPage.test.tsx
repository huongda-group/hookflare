import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { project, source, T } from "../helpers/fixtures";
import { renderApp } from "../helpers/render";
import { apiUrl, server } from "../helpers/server";

function overviewHandlers() {
	server.use(
		http.get(apiUrl("/projects/prj_1"), () => HttpResponse.json(project())),
		http.get(apiUrl("/overview"), () =>
			HttpResponse.json({
				range: "24h",
				from: T - 23 * 3_600_000,
				to: T + 3_600_000,
				generated_at: T,
				totals: {
					received: 0,
					delivered: 0,
					success_rate: null,
					failed_final: 0,
					dead: 0,
				},
				live: { pending: 0, queued: 0, in_flight: 0, retrying: 0, paused: 0 },
				trend: [],
				failing_destinations: [],
				open_alerts: { count: 0 },
			}),
		),
		http.get(apiUrl("/sources"), () =>
			HttpResponse.json({ data: [], next_cursor: null }),
		),
		http.get(apiUrl("/destinations"), () =>
			HttpResponse.json({ data: [], next_cursor: null }),
		),
	);
}

describe("Project detail (spec §8.5)", () => {
	it("shows the project with scoped navigation to its endpoints", async () => {
		overviewHandlers();
		renderApp("/projects/prj_1");
		expect(
			await screen.findByRole("heading", { name: "Payments" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: /back to projects/i }),
		).toHaveAttribute("href", "/projects");
		const nav = screen.getByRole("navigation", { name: /project/i });
		for (const name of [/sources/i, /destinations/i, /events/i]) {
			const link = within(nav).getByRole("link", { name });
			expect(link.getAttribute("href")).toContain("project_id=prj_1");
		}
	});

	it("offers creation paths when the project is empty", async () => {
		overviewHandlers();
		renderApp("/projects/prj_1");
		expect(
			await screen.findByRole("heading", { name: /no sources/i }),
		).toBeInTheDocument();
		for (const name of [/new source/i, /new destination/i]) {
			const link = screen.getByRole("link", { name });
			expect(link.getAttribute("href")).toContain("project_id=prj_1");
		}
	});

	it("disables without offering delete", async () => {
		overviewHandlers();
		const patches: unknown[] = [];
		server.use(
			http.patch(apiUrl("/projects/prj_1"), async ({ request }) => {
				patches.push(await request.json());
				return HttpResponse.json(project({ status: "disabled" }));
			}),
		);
		const { user } = renderApp("/projects/prj_1");
		expect(
			await screen.findByRole("heading", { name: "Payments" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /delete/i }),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Disable" }));
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("button", { name: "Disable" }));
		await waitFor(() => expect(patches).toHaveLength(1));
		expect(patches[0]).toEqual({ status: "disabled" });
	});
	it("re-enables a disabled project that already has endpoints", async () => {
		overviewHandlers();
		const patches: unknown[] = [];
		let status: "active" | "disabled" = "disabled";
		server.use(
			http.get(apiUrl("/projects/prj_1"), () =>
				HttpResponse.json(project({ status })),
			),
			http.get(apiUrl("/sources"), () =>
				HttpResponse.json({ data: [source()], next_cursor: null }),
			),
			http.patch(apiUrl("/projects/prj_1"), async ({ request }) => {
				patches.push(await request.json());
				status = "active";
				return HttpResponse.json(project({ status }));
			}),
		);
		const { user } = renderApp("/projects/prj_1");
		expect(
			await screen.findByRole("heading", { name: "Payments" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: /no sources/i }),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Enable" }));
		const dialog = await screen.findByRole("dialog", {
			name: "Enable Payments?",
		});
		expect(dialog).toHaveTextContent("Sources accept events again.");
		await user.click(within(dialog).getByRole("button", { name: "Enable" }));
		await waitFor(() => expect(patches).toEqual([{ status: "active" }]));
		expect(
			await screen.findByRole("button", { name: "Disable" }),
		).toBeInTheDocument();
	});

	it("keeps the reporting period in the URL", async () => {
		overviewHandlers();
		const { user, router } = renderApp("/projects/prj_1");
		await user.click(await screen.findByRole("tab", { name: "7d" }));
		await waitFor(() =>
			expect(router.state.location.search).toEqual({ range: "7d" }),
		);
		expect(router.state.location.pathname).toBe("/projects/prj_1");
	});
});
