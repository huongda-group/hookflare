import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { destination, T } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";
import { invalidateDeliveryViews } from "@/lib/queries/invalidate-delivery-views";

vi.mock("@/lib/queries/invalidate-delivery-views", () => ({
	invalidateDeliveryViews: vi.fn(),
}));

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
							actor: "ops",
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
		const row = (await screen.findByText("ops")).closest("tr") as HTMLElement;
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

	it("explains the pause hold and refreshes scoped views", async () => {
		const posts: unknown[] = [];
		server.use(
			http.get(apiUrl("/destinations/dst_1"), () =>
				HttpResponse.json(destination()),
			),
			http.post(apiUrl("/destinations/dst_1/pause"), async ({ request }) => {
				posts.push(await request.json());
				return HttpResponse.json(destination({ status: "paused" }));
			}),
		);
		const { user } = renderApp(PATH);
		await screen.findByRole("heading", { name: "Billing API" });
		await user.click(screen.getByRole("button", { name: "Actions" }));
		await user.click(await screen.findByRole("menuitem", { name: "Pause" }));
		expect(
			await screen.findByText(/held as paused until you resume/i),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Pause" }));
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(invalidateDeliveryViews).toHaveBeenCalled();
	});

	it("explains the resume release and refreshes scoped views", async () => {
		server.use(
			http.get(apiUrl("/destinations/dst_1"), () =>
				HttpResponse.json(destination({ status: "paused" })),
			),
			http.post(apiUrl("/destinations/dst_1/resume"), () =>
				HttpResponse.json(destination()),
			),
		);
		const { user } = renderApp(PATH);
		await screen.findByRole("heading", { name: "Billing API" });
		await user.click(screen.getByRole("button", { name: "Actions" }));
		await user.click(await screen.findByRole("menuitem", { name: "Resume" }));
		expect(
			await screen.findByText(/enqueued again/i),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Resume" }));
		await waitFor(() => expect(invalidateDeliveryViews).toHaveBeenCalled());
	});

	it("shows the synchronous test outcome without polling", async () => {
		let posts = 0;
		let polls = 0;
		server.use(
			http.get(apiUrl("/destinations/dst_1"), () =>
				HttpResponse.json(destination()),
			),
			http.get(apiUrl("/destinations/dst_1/tests"), () => {
				polls += 1;
				return HttpResponse.json({ data: [], next_cursor: null });
			}),
			http.post(apiUrl("/destinations/dst_1/test"), () => {
				posts += 1;
				return HttpResponse.json({
					id: "tst_1",
					kind: "test",
					http_status: 204,
					error_kind: null,
					error_message: null,
					response_snippet: null,
					duration_ms: 87,
				});
			}),
		);
		const { user } = renderApp(PATH);
		await screen.findByRole("heading", { name: "Billing API" });
		const mountedPolls = polls;
		await user.click(screen.getByRole("button", { name: "Actions" }));
		await user.click(await screen.findByRole("menuitem", { name: "Send test" }));
		await user.click(await screen.findByRole("button", { name: "Send" }));
		expect(await screen.findByText(/test delivery/i)).toBeInTheDocument();
		expect(screen.getByText(/HTTP 204/)).toBeInTheDocument();
		expect(posts).toBe(1);
		expect(polls - mountedPolls).toBeLessThanOrEqual(1);
	});

	it("rotates with overlap, reveals once, and forgets the secret", async () => {
		let rotated = false;
		server.use(
			http.get(apiUrl("/destinations/dst_1"), () =>
				HttpResponse.json(
					rotated
						? destination({
								previous_secret_fingerprint: "99ff00aa",
								previous_secret_expires_at: T + 86_400_000,
							})
						: destination(),
				),
			),
			http.post(apiUrl("/destinations/dst_1/rotate-secret"), () => {
				rotated = true;
				return HttpResponse.json({
					id: "dst_1",
					signing_secret: "whsec_rotated",
				});
			}),
		);
		const { user } = renderApp(PATH);
		await screen.findByRole("heading", { name: "Billing API" });
		await user.click(screen.getByRole("button", { name: "Actions" }));
		await user.click(
			await screen.findByRole("menuitem", { name: "Rotate secret" }),
		);
		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByText(/rotate secret for billing api/i),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Rotate" }));
		expect(
			await screen.findByText("whsec_rotated"),
		).toBeInTheDocument();
		await user.click(screen.getByLabelText("I have stored this secret"));
		await user.click(screen.getByRole("button", { name: "Done" }));
		await waitFor(() =>
			expect(screen.queryByText("whsec_rotated")).not.toBeInTheDocument(),
		);
		expect(await screen.findByText("99ff00aa")).toBeInTheDocument();
		expect(
			screen.getByText(/previous secret valid until/i),
		).toBeInTheDocument();
	});
});
