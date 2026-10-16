import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { T } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

const row = {
	id: "aud_1",
	actor_email: "admin@example.com",
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
		const { user } = renderApp("/audit?action=destination.updated");
		expect(await screen.findByText("destination.updated")).toBeInTheDocument();
		expect(seen.get("action")).toBe("destination.updated");
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
});
