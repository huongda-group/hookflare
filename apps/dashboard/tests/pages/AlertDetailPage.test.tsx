import type { Alert } from "@hookflare/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { alert, project, T } from "../helpers/fixtures";
import { renderApp } from "../helpers/render";
import { apiUrl, server } from "../helpers/server";

function detail(
	o: Partial<Alert> = {},
	notifications = [
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
	],
) {
	return { ...alert(), notifications, ...o };
}

describe("Alert detail", () => {
	it.each(["prj_2", null])(
		"resolves a notification link with no scope (incident project %s)",
		async (id) => {
			const queries: string[] = [];
			localStorage.setItem("hookflare.activeProjectId", "prj_1");
			server.use(
				http.get(apiUrl("/projects"), () =>
					HttpResponse.json({
						data: [project(), project({ id: "prj_2", name: "Shipping" })],
						next_cursor: null,
					}),
				),
				http.get(apiUrl("/alerts/alr_notification"), ({ request }) => {
					const q = new URL(request.url).search;
					queries.push(q);
					const scoped =
						id === null ? "?scope=deployment" : "?project_id=prj_2";
					return !q || q === scoped
						? HttpResponse.json(
								detail({ id: "alr_notification", project_id: id }),
							)
						: new HttpResponse(null, { status: 404 });
				}),
			);
			const { router } = renderApp("/alerts/alr_notification");
			try {
				await waitFor(() =>
					expect(router.state.location.search).toMatchObject(
						id === null ? { scope: "deployment" } : { project_id: id },
					),
				);
				expect(
					await screen.findByRole("table", { name: /notifications/i }),
				).toBeVisible();
				expect(queries).toEqual([
					"",
					id === null ? "?scope=deployment" : "?project_id=prj_2",
				]);
				expect(
					screen.getByRole("combobox", { name: "Active project" }),
				).toHaveTextContent(id === "prj_2" ? "Shipping" : "Payments");
			} finally {
				localStorage.removeItem("hookflare.activeProjectId");
			}
		},
	);

	it("does not repair an explicitly mismatched project on an alert link", async () => {
		const queries: string[] = [];
		server.use(
			http.get(apiUrl("/alerts/alr_other"), ({ request }) => {
				const q = new URL(request.url).search;
				queries.push(q);
				return q
					? new HttpResponse(null, { status: 404 })
					: HttpResponse.json(detail({ project_id: "prj_2" }));
			}),
		);
		renderApp("/alerts/alr_other?project_id=prj_1");
		expect(
			await screen.findByText("Alert alr_other was not found."),
		).toBeVisible();
		expect(queries).toEqual(["?project_id=prj_1"]);
	});
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
			http.get(apiUrl("/alerts/alr_9"), () => HttpResponse.json(detail())),
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
			http.get(
				apiUrl("/alerts/alr_nope"),
				() => new HttpResponse(null, { status: 404 }),
			),
		);
		renderApp("/alerts/alr_nope");
		expect(await screen.findByText(/was not found/i)).toBeInTheDocument();
	});
});
