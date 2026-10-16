import { screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { failure } from "@/test/fixtures";
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
});
