import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

describe("AppShell", () => {
	it("shows the signed-in user and every nav item to an admin", async () => {
		renderApp("/");
		expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
		for (const name of [
			"Overview",
			"Projects",
			"Endpoints",
			"Events",
			"Failures",
			"Audit",
			"Settings",
		]) {
			expect(screen.getByRole("link", { name })).toBeInTheDocument();
		}
	});

	it("hides Audit from viewers", async () => {
		renderApp("/", { role: "viewer" });
		await screen.findByText("viewer@example.com");
		expect(
			screen.queryByRole("link", { name: "Audit" }),
		).not.toBeInTheDocument();
	});

	it("refetches /me after a 403 from any call", async () => {
		let meCalls = 0;
		server.use(
			http.get(apiUrl("/me"), () => {
				meCalls++;
				return HttpResponse.json({
					username: "admin@example.com",
					role: "admin",
					permissions: ["events.read"],
				});
			}),
		);
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json(
					{ error: "forbidden", required: "events.read" },
					{ status: 403 },
				),
			),
		);
		const { queryClient } = renderApp("/");
		await screen.findByText("admin@example.com");
		await queryClient
			.fetchQuery({
				queryKey: ["probe403"],
				queryFn: () => import("@/lib/api").then((m) => m.api.get("/projects")),
			})
			.catch(() => {});
		await waitFor(() => expect(meCalls).toBeGreaterThanOrEqual(2));
	});

	it("shows an error with Retry when /me fails with a non-403 error", async () => {
		let fail = true;
		server.use(
			http.get(apiUrl("/me"), () =>
				fail
					? HttpResponse.json({ error: "internal" }, { status: 500 })
					: HttpResponse.json({
							username: "admin@example.com",
							role: "admin",
							permissions: ["events.read"],
						}),
			),
		);
		const { user } = renderApp("/");
		await user.click(await screen.findByRole("button", { name: "Retry" }));
		expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
		fail = false;
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
	});
});
