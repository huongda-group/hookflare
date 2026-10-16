import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { toLocalInput } from "@/lib/time";
import { destination, failure, project, T } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

describe("Failures", () => {
	it("shows the Dead Letter tab by default, filtered by status and unresolved", async () => {
		let seen = new URLSearchParams();
		server.use(
			http.get(apiUrl("/failures"), ({ request }) => {
				seen = new URL(request.url).searchParams;
				return HttpResponse.json({ data: [failure()], next_cursor: null });
			}),
		);
		renderApp("/failures");
		expect(await screen.findByText("dlv_1")).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Dead Letter" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(seen.getAll("status")).toEqual(["dead"]);
		expect(seen.get("unresolved")).toBe("true");
	});

	it("bulk-replays the selected rows", async () => {
		const sent = vi.fn();
		server.use(
			http.get(apiUrl("/failures"), () =>
				HttpResponse.json({
					data: [failure(), failure({ id: "dlv_2" })],
					next_cursor: null,
				}),
			),
			http.post(apiUrl("/failures/replay"), async ({ request }) => {
				sent(await request.json());
				return HttpResponse.json({ replayed: [], skipped: [] });
			}),
		);
		const { user } = renderApp("/failures", { role: "operator" });
		await user.click(await screen.findByLabelText("Select dlv_1"));
		await user.click(screen.getByLabelText("Select dlv_2"));
		await user.click(
			screen.getByRole("button", { name: "Replay selected (2)" }),
		);
		await user.type(screen.getByLabelText("Reason"), "fixed");
		await user.click(screen.getByRole("button", { name: "Replay 2" }));
		await vi.waitFor(() =>
			expect(sent).toHaveBeenCalledWith({
				delivery_ids: ["dlv_1", "dlv_2"],
				reason: "fixed",
			}),
		);
	});

	it("hides selection and replay from viewers", async () => {
		server.use(
			http.get(apiUrl("/failures"), () =>
				HttpResponse.json({ data: [failure()], next_cursor: null }),
			),
		);
		renderApp("/failures", { role: "viewer" });
		await screen.findByText("dlv_1");
		expect(screen.queryByLabelText("Select dlv_1")).not.toBeInTheDocument();
	});

	it("shows the latest replay of an already-replayed failure", async () => {
		server.use(
			http.get(apiUrl("/failures"), () =>
				HttpResponse.json({
					data: [
						failure({ latest_replay: { id: "dlv_9", status: "delivered" } }),
					],
					next_cursor: null,
				}),
			),
		);
		renderApp("/failures?unresolved=false");
		expect(await screen.findByText("dlv_9")).toBeInTheDocument();
	});

	describe("URL filters (spec §12.2)", () => {
		const capture = () => {
			const calls: URLSearchParams[] = [];
			server.use(
				http.get(apiUrl("/failures"), ({ request }) => {
					calls.push(new URL(request.url).searchParams);
					return HttpResponse.json({ data: [failure()], next_cursor: null });
				}),
				http.get(apiUrl("/projects"), () =>
					HttpResponse.json({ data: [project()], next_cursor: null }),
				),
				http.get(apiUrl("/destinations"), () =>
					HttpResponse.json({
						data: [destination(), destination({ id: "dst_2", name: "Ledger" })],
						next_cursor: null,
					}),
				),
			);
			return calls;
		};

		it("restores tab, project and unresolved from the URL", async () => {
			const calls = capture();
			renderApp("/failures?tab=failed_final&project_id=prj_1&unresolved=false");
			await screen.findByText("dlv_1");
			const seen = calls.at(-1) as URLSearchParams;
			expect(seen.getAll("status")).toEqual(["failed_final"]);
			expect(seen.get("project_id")).toBe("prj_1");
			expect(seen.get("unresolved")).toBe("false");
			expect(seen.has("destination_id")).toBe(false);
			expect(screen.getByRole("tab", { name: "Failed Final" })).toHaveAttribute(
				"aria-selected",
				"true",
			);
			await waitFor(() =>
				expect(screen.getByLabelText("Project")).toHaveTextContent("Payments"),
			);
			expect(screen.getByLabelText(/unresolved only/i)).not.toBeChecked();
		});

		it("restores destination and time range from the URL", async () => {
			const calls = capture();
			const from = T - 86_400_000;
			const to = T;
			renderApp(`/failures?destination_id=dst_2&from=${from}&to=${to}`);
			await screen.findByText("dlv_1");
			const seen = calls.at(-1) as URLSearchParams;
			expect(seen.get("destination_id")).toBe("dst_2");
			expect(seen.get("from")).toBe(String(from));
			expect(seen.get("to")).toBe(String(to));
			await waitFor(() =>
				expect(screen.getByLabelText("Destination")).toHaveTextContent(
					"Ledger",
				),
			);
			expect(screen.getByLabelText("From")).toHaveValue(toLocalInput(from));
			expect(screen.getByLabelText("To")).toHaveValue(toLocalInput(to));
			expect(
				screen.getByRole("button", { name: "Clear time range" }),
			).toBeInTheDocument();
		});

		it("filters by destination and clears the selection", async () => {
			const calls = capture();
			const { user, router } = renderApp("/failures", { role: "operator" });
			await user.click(await screen.findByLabelText("Select dlv_1"));
			expect(
				screen.getByRole("button", { name: "Replay selected (1)" }),
			).toBeInTheDocument();
			await user.click(screen.getByLabelText("Destination"));
			await user.click(await screen.findByRole("option", { name: "Ledger" }));
			await waitFor(() =>
				expect(calls.at(-1)?.get("destination_id")).toBe("dst_2"),
			);
			expect(router.state.location.search).toMatchObject({
				destination_id: "dst_2",
			});
			expect(
				screen.getByRole("button", { name: "Replay selected (0)" }),
			).toBeInTheDocument();
			await user.click(screen.getByLabelText("Destination"));
			await user.click(
				await screen.findByRole("option", { name: "All destinations" }),
			);
			await waitFor(() =>
				expect(calls.at(-1)?.has("destination_id")).toBe(false),
			);
		});

		it("applies a time-range preset and clears it", async () => {
			const calls = capture();
			const { user, router } = renderApp("/failures");
			await screen.findByText("dlv_1");
			const before = Date.now();
			await user.click(screen.getByRole("button", { name: "Last 24h" }));
			await waitFor(() => expect(calls.at(-1)?.has("from")).toBe(true));
			const from = Number(calls.at(-1)?.get("from"));
			expect(from).toBeGreaterThanOrEqual(before - 86_400_000);
			expect(from).toBeLessThanOrEqual(Date.now() - 86_400_000);
			expect(router.state.location.search).toMatchObject({ from });
			await user.click(
				screen.getByRole("button", { name: "Clear time range" }),
			);
			await waitFor(() => expect(calls.at(-1)?.has("from")).toBe(false));
			expect(screen.getByLabelText("From")).toHaveValue("");
		});
	});
});
