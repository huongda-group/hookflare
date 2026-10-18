import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { T } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

const row = {
	id: "aud_1",
	actor: "ops-lead",
	action: "destination.updated",
	resource_type: "destination",
	resource_id: "dst_1",
	reason: "tune retries",
	diff: { max_attempts: { before: 20, after: 5 } },
	at: T,
};

describe("Audit", () => {
	it("lists entries and expands the diff", async () => {
		let seen = new URLSearchParams();
		server.use(
			http.get(apiUrl("/audit-logs"), ({ request }) => {
				seen = new URL(request.url).searchParams;
				return HttpResponse.json({ data: [row], next_cursor: null });
			}),
		);
		const { user } = renderApp(
			"/audit?action=destination.updated&actor=ops-lead",
		);
		expect(await screen.findByText("destination.updated")).toBeInTheDocument();
		expect(screen.getByText("ops-lead")).toBeInTheDocument();
		expect(seen.get("action")).toBe("destination.updated");
		expect(seen.get("actor")).toBe("ops-lead");
		await user.click(screen.getByRole("button", { name: "Show diff" }));
		expect(screen.getByRole("list", { name: "JSON" })).toBeInTheDocument();
	});

	it("tells non-admins they cannot view the audit log", async () => {
		renderApp("/audit", { role: "operator" });
		expect(
			await screen.findByText(/requires the admin role/i),
		).toBeInTheDocument();
	});

	it("refreshes filter inputs on back/forward", async () => {
		const { router } = renderApp("/audit?action=one");
		expect(await screen.findByLabelText("Action")).toHaveValue("one");
		await router.navigate({ to: "/audit", search: { action: "two" } });
		await waitFor(() =>
			expect(screen.getByLabelText("Action")).toHaveValue("two"),
		);
		router.history.back();
		await waitFor(() =>
			expect(screen.getByLabelText("Action")).toHaveValue("one"),
		);
	});

	it("distinguishes an empty log from a failed load", async () => {
		renderApp("/audit");
		expect(
			await screen.findByText(/no audit entries match/i),
		).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("shows a retryable error when the log fails", async () => {
		server.use(
			http.get(apiUrl("/audit-logs"), () => new HttpResponse(null, { status: 500 })),
		);
		renderApp("/audit");
		expect(
			await screen.findByRole("button", { name: /retry/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("alert")).toBeInTheDocument();
	});

	it("escapes secrets inside the diff instead of rendering markup", async () => {
		server.use(
			http.get(apiUrl("/audit-logs"), () =>
				HttpResponse.json({
					data: [
						{
							...row,
							diff: {
								signing_secret: {
									before: "<script>alert(1)</script>",
									after: "[redacted]",
								},
							},
						},
					],
					next_cursor: null,
				}),
			),
		);
		const { user } = renderApp("/audit");
		expect(await screen.findByText("destination.updated")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Show diff" }));
		expect(
			await screen.findByText(/<script>alert\(1\)<\/script>/),
		).toBeInTheDocument();
		expect(document.querySelector("script")).toBeNull();
	});

	it("fires no audit requests when a viewer navigates directly", async () => {
		let hits = 0;
		server.use(
			http.get(apiUrl("/audit-logs"), () => {
				hits += 1;
				return HttpResponse.json({ data: [], next_cursor: null });
			}),
		);
		renderApp("/audit", { role: "viewer" });
		expect(
			await screen.findByText(/requires the admin role/i),
		).toBeInTheDocument();
		await new Promise((r) => setTimeout(r, 100));
		expect(hits).toBe(0);
	});
});
