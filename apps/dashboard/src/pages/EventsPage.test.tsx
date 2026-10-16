import { screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { eventSummary } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

describe("Events", () => {
	it("sends URL filters to the API, repeating status", async () => {
		let seen = new URLSearchParams();
		server.use(
			http.get(apiUrl("/events"), ({ request }) => {
				seen = new URL(request.url).searchParams;
				return HttpResponse.json({ data: [eventSummary()], next_cursor: null });
			}),
		);
		renderApp(
			"/events?status=%5B%22dead%22%2C%22retrying%22%5D&http_status=503",
		);
		expect(await screen.findByText("evt_1")).toBeInTheDocument();
		expect(seen.getAll("status")).toEqual(["dead", "retrying"]);
		expect(seen.get("http_status")).toBe("503");
		expect(screen.getByText("HTTP 503")).toBeInTheDocument();
	});

	it("opens the detail page when the search box gets an event ID", async () => {
		server.use(
			http.get(apiUrl("/events/evt_42"), () =>
				HttpResponse.json({ error: "not_found" }, { status: 404 }),
			),
		);
		const { user, router } = renderApp("/events");
		await user.type(await screen.findByLabelText("Search"), "evt_42{Enter}");
		expect(router.state.location.pathname).toBe("/events/evt_42");
	});

	it("asks for a source before searching a provider event ID", async () => {
		const { user } = renderApp("/events");
		await user.type(await screen.findByLabelText("Search"), "pi_123{Enter}");
		expect(await screen.findByText(/choose a source/i)).toBeInTheDocument();
	});

	it("shows Load more when there is a next cursor and appends the next page", async () => {
		server.use(
			http.get(apiUrl("/events"), ({ request }) => {
				const cursor = new URL(request.url).searchParams.get("cursor");
				return cursor
					? HttpResponse.json({
							data: [eventSummary({ id: "evt_2" })],
							next_cursor: null,
						})
					: HttpResponse.json({ data: [eventSummary()], next_cursor: "c1" });
			}),
		);
		const { user } = renderApp("/events");
		await user.click(await screen.findByRole("button", { name: "Load more" }));
		expect(await screen.findByText("evt_2")).toBeInTheDocument();
		expect(screen.getByText("evt_1")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Load more" }),
		).not.toBeInTheDocument();
	});
});
