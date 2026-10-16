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

	it("shows No access with the email when /me answers 403", async () => {
		server.use(
			http.get(apiUrl("/me"), () =>
				HttpResponse.json(
					{ error: "forbidden", email: "x@example.com" },
					{ status: 403 },
				),
			),
		);
		renderApp("/");
		expect(
			await screen.findByRole("heading", { name: "No access" }),
		).toBeInTheDocument();
		expect(screen.getByText(/x@example.com/)).toBeInTheDocument();
	});

	it("keeps the page mounted under the session-expired banner", async () => {
		const { queryClient } = renderApp("/");
		await screen.findByText("admin@example.com");
		server.use(
			http.get(
				apiUrl("/projects"),
				() =>
					new HttpResponse("<html/>", {
						headers: { "content-type": "text/html" },
					}),
			),
		);
		await queryClient
			.fetchQuery({
				queryKey: ["probe"],
				queryFn: () => import("@/lib/api").then((m) => m.api.get("/projects")),
			})
			.catch(() => {});
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Session expired",
		);
		expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
		expect(screen.getByText("admin@example.com")).toBeInTheDocument();
	});

	it("refetches /me after a 403 from any call", async () => {
		let meCalls = 0;
		server.use(
			http.get(apiUrl("/me"), () => {
				meCalls++;
				return HttpResponse.json({
					email: "admin@example.com",
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
});
