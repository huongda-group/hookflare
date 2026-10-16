import { screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { destination, T } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

const PATH = "/endpoints/destinations/dst_1";

describe("Destination detail", () => {
	it("shows the config with effective defaults and the fingerprint", async () => {
		server.use(
			http.get(apiUrl("/destinations/dst_1"), () =>
				HttpResponse.json(destination({ timeout_ms: 5000 })),
			),
		);
		renderApp(PATH);
		expect(
			await screen.findByRole("heading", { name: "Billing API" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("https://billing.example.com/hooks"),
		).toBeInTheDocument();
		expect(screen.getByText("ab12cd34")).toBeInTheDocument();
		const timeout = screen.getByText("Timeout").closest("div") as HTMLElement;
		expect(within(timeout).getByText("5000 ms")).toBeInTheDocument();
		const attempts = screen
			.getByText("Max attempts")
			.closest("div") as HTMLElement;
		expect(
			await within(attempts).findByText("default: 20"),
		).toBeInTheDocument();
		expect(screen.queryByText(/previous secret/i)).not.toBeInTheDocument();
	});

	it("shows the grace window when a previous secret is still valid", async () => {
		server.use(
			http.get(apiUrl("/destinations/dst_1"), () =>
				HttpResponse.json(
					destination({
						previous_secret_fingerprint: "99ff00aa",
						previous_secret_expires_at: T + 86_400_000,
					}),
				),
			),
		);
		renderApp(PATH);
		expect(await screen.findByText("99ff00aa")).toBeInTheDocument();
		expect(
			screen.getByText(/previous secret valid until/i),
		).toBeInTheDocument();
	});

	it("lists test deliveries and stats", async () => {
		server.use(
			http.get(apiUrl("/destinations/dst_1"), () =>
				HttpResponse.json(destination()),
			),
			http.get(apiUrl("/destinations/dst_1/tests"), () =>
				HttpResponse.json({
					data: [
						{
							id: "tst_1",
							destination_id: "dst_1",
							actor_email: "ops@example.com",
							started_at: T,
							duration_ms: 87,
							http_status: 204,
							error_kind: null,
							error_message: null,
							response_snippet: null,
						},
					],
					next_cursor: null,
				}),
			),
			http.get(apiUrl("/destinations/stats"), () =>
				HttpResponse.json({
					data: [
						{
							destination_id: "dst_1",
							delivered: 98,
							failed: 2,
							success_rate: 0.98,
							last_delivery_at: T,
							last_http_status: 503,
							last_error: "HTTP 503",
						},
					],
				}),
			),
		);
		renderApp(PATH);
		const row = (await screen.findByText("ops@example.com")).closest(
			"tr",
		) as HTMLElement;
		expect(within(row).getByText("HTTP 204")).toBeInTheDocument();
		expect(within(row).getByText("87 ms")).toBeInTheDocument();
		expect(await screen.findByText("98.0%")).toBeInTheDocument();
	});

	it("shows actions to operators and hides them from viewers", async () => {
		server.use(
			http.get(apiUrl("/destinations/dst_1"), () =>
				HttpResponse.json(destination()),
			),
		);
		renderApp(PATH, { role: "viewer" });
		await screen.findByRole("heading", { name: "Billing API" });
		expect(
			screen.queryByRole("button", { name: "Actions" }),
		).not.toBeInTheDocument();
	});

	it("shows a not-found state on 404", async () => {
		server.use(
			http.get(apiUrl("/destinations/dst_x"), () =>
				HttpResponse.json({ error: "not_found" }, { status: 404 }),
			),
		);
		renderApp("/endpoints/destinations/dst_x");
		expect(
			await screen.findByText(/destination dst_x was not found/i),
		).toBeInTheDocument();
	});
});
