import type { Alert } from "@hookflare/shared";
import { screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { alert, project } from "../helpers/fixtures";
import { chooseProject, renderApp } from "../helpers/render";
import { apiUrl, server } from "../helpers/server";

const isDeployment = (request: Request) =>
	new URL(request.url).searchParams.get("scope") === "deployment";
const empty = () => HttpResponse.json({ data: [], next_cursor: null });

describe("Alerts page", () => {
	it("keeps deployment incidents separate when the selected project changes", async () => {
		const system = alert({
			id: "alr_system",
			project_id: null,
			resource_type: "system",
			resource_id: "storage",
			rule: "d1_storage",
		});
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({
					data: [project(), project({ id: "prj_2", name: "Shipping" })],
					next_cursor: null,
				}),
			),
			http.get(apiUrl("/alerts"), ({ request }) => {
				const q = new URL(request.url).searchParams;
				return HttpResponse.json({
					data:
						q.get("scope") === "deployment"
							? [system]
							: q.get("project_id") === "prj_1"
								? [alert()]
								: [],
					next_cursor: null,
				});
			}),
			http.get(apiUrl("/alerts/alr_system"), ({ request }) =>
				new URL(request.url).searchParams.get("scope") === "deployment"
					? HttpResponse.json({ ...system, notifications: [] })
					: new HttpResponse(null, { status: 404 }),
			),
		);
		const { user } = renderApp("/alerts?project_id=prj_1");
		const projectSection = within(
			await screen.findByRole("region", { name: "Project incidents" }),
		);
		const deploymentSection = within(
			screen.getByRole("region", { name: "Deployment incidents" }),
		);
		expect(
			await projectSection.findByRole("link", { name: "Billing API" }),
		).toBeVisible();
		expect(
			await deploymentSection.findByRole("link", { name: "system / storage" }),
		).toBeVisible();
		await chooseProject(user, "Shipping");
		expect(
			await screen.findByText("No project alerts match these filters."),
		).toBeVisible();
		await user.click(
			await screen.findByRole("link", { name: "system / storage" }),
		);
		expect(await screen.findByText("Deployment-wide")).toBeVisible();
	});
	it("lists incidents and filters by status via the URL", async () => {
		const seen: string[] = [];
		server.use(
			http.get(apiUrl("/alerts"), ({ request }) => {
				if (isDeployment(request)) return empty();
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

	it("renders an unknown rule as a readable fallback instead of breaking", async () => {
		server.use(
			http.get(apiUrl("/alerts"), ({ request }) =>
				isDeployment(request)
					? empty()
					: HttpResponse.json({
							data: [
								alert({
									rule: "future_rule_xyz" as Alert["rule"],
									resource_name: "Billing API",
								}),
							],
							next_cursor: null,
						}),
			),
		);
		renderApp("/alerts?status=open");
		expect(await screen.findByText("Billing API")).toBeInTheDocument();
		expect(screen.getByText(/unknown rule/i)).toBeInTheDocument();
		expect(screen.getByText(/future_rule_xyz/)).toBeInTheDocument();
	});

	it("keeps system alerts visible in the deployment section", async () => {
		const seen: string[] = [];
		server.use(
			http.get(apiUrl("/alerts"), ({ request }) => {
				if (!isDeployment(request)) return empty();
				seen.push(new URL(request.url).search);
				return HttpResponse.json({
					data: [
						alert({
							resource_type: "system",
							resource_id: "host-9",
							resource_name: null,
							project_id: null,
						}),
					],
					next_cursor: null,
				});
			}),
		);
		renderApp("/alerts?status=open&project_id=prj_1");
		expect(await screen.findByText("system / host-9")).toBeInTheDocument();
		expect(seen.at(-1)).toContain("scope=deployment");
	});

	it("distinguishes an empty list from a failed list", async () => {
		renderApp("/alerts?status=open");
		expect(
			await screen.findByText("No project alerts match these filters."),
		).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("shows a retryable error when the list fails", async () => {
		server.use(
			http.get(apiUrl("/alerts"), ({ request }) =>
				isDeployment(request)
					? empty()
					: new HttpResponse(null, { status: 500 }),
			),
		);
		renderApp("/alerts?status=open");
		expect(
			await screen.findByRole("button", { name: /retry/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("alert")).toBeInTheDocument();
	});

	it("keeps loaded rows when the next page fails", async () => {
		let calls = 0;
		server.use(
			http.get(apiUrl("/alerts"), ({ request }) => {
				if (isDeployment(request)) return empty();
				calls += 1;
				if (calls === 1)
					return HttpResponse.json({ data: [alert()], next_cursor: "c1" });
				return new HttpResponse(null, { status: 500 });
			}),
		);
		const { user } = renderApp("/alerts?status=open");
		expect(await screen.findByText("Billing API")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /load more/i }));
		expect(
			await screen.findByRole("button", { name: /retry loading more/i }),
		).toBeInTheDocument();
		expect(screen.getByText("Billing API")).toBeInTheDocument();
	});
});
