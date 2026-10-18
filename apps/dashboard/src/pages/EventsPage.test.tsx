import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { eventSummary, project, T } from "@/test/fixtures";
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
		expect(await screen.findByRole("link", { name: "evt_1" })).toBeInTheDocument();
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
		expect(await screen.findByRole("link", { name: "evt_2" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "evt_1" })).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Load more" }),
		).not.toBeInTheDocument();
	});

	it("refreshes named filter inputs on back/forward", async () => {
		const { router } = renderApp("/events?source_id=src_1&destination_id=dst_1");
		expect(await screen.findByLabelText("Source")).toHaveTextContent("src_1");
		expect(screen.getByLabelText("Destination")).toHaveTextContent("dst_1");
		await router.navigate({ to: "/events", search: { source_id: "src_2" } });
		await waitFor(() =>
			expect(screen.getByLabelText("Source")).toHaveTextContent("src_2"),
		);
		expect(screen.getByLabelText("Destination")).toHaveTextContent(
			"All destinations",
		);
		router.history.back();
		await waitFor(() =>
			expect(screen.getByLabelText("Source")).toHaveTextContent("src_1"),
		);
		expect(screen.getByLabelText("Destination")).toHaveTextContent("dst_1");
	});

	it("preserves text drafts on unrelated commits but refreshes on navigation", async () => {
		server.use(
			http.get(apiUrl("/events"), () =>
				HttpResponse.json({ data: [eventSummary()], next_cursor: null }),
			),
		);
		const { user, router } = renderApp(
			"/events?project_id=prj_1&source_id=src_1",
		);
		await screen.findByRole("link", { name: "evt_1" });
		const box = screen.getByLabelText("Search");
		const httpBox = screen.getByLabelText("HTTP status");
		await user.type(box, "pi_draft");
		await user.type(httpBox, "50");
		// Unrelated commit: toggling a status must not drop uncommitted drafts.
		await user.click(screen.getByRole("button", { name: "dead" }));
		await waitFor(() =>
			expect(router.state.location.search).toMatchObject({
				status: ["dead"],
			}),
		);
		expect(box).toHaveValue("pi_draft");
		expect(httpBox).toHaveValue(50);
		expect(router.state.location.search).not.toMatchObject({
			provider_event_id: "pi_draft",
		});
		// Navigation to a different committed value refreshes the drafts.
		await router.navigate({
			to: "/events",
			search: {
				project_id: "prj_1",
				source_id: "src_1",
				provider_event_id: "pi_nav",
				http_status: 503,
			},
		});
		await waitFor(() => expect(box).toHaveValue("pi_nav"));
		expect(httpBox).toHaveValue(503);
		router.history.back();
		await waitFor(() => expect(box).toHaveValue(""));
		expect(httpBox).toHaveValue(null);
	});

	it("sends an exact provider event ID only on submit, never per keystroke", async () => {
		let seen = new URLSearchParams();
		server.use(
			http.get(apiUrl("/events"), ({ request }) => {
				seen = new URL(request.url).searchParams;
				return HttpResponse.json({ data: [eventSummary()], next_cursor: null });
			}),
		);
		const { user, router } = renderApp("/events?project_id=prj_1&source_id=src_1");
		await screen.findByRole("link", { name: "evt_1" });
		const box = screen.getByLabelText("Search");
		await user.type(box, "pi_123");
		expect(router.state.location.search).not.toMatchObject({
			provider_event_id: "pi_123",
		});
		await user.type(box, "{Enter}");
		await waitFor(() =>
			expect(router.state.location.search).toMatchObject({
				provider_event_id: "pi_123",
			}),
		);
		expect(seen.get("provider_event_id")).toBe("pi_123");
	});

	it("commits drafts on Apply and resets to project-preserving defaults on Clear", async () => {
		const seen: URLSearchParams[] = [];
		server.use(
			http.get(apiUrl("/events"), ({ request }) => {
				seen.push(new URL(request.url).searchParams);
				return HttpResponse.json({ data: [eventSummary()], next_cursor: null });
			}),
		);
		const { user, router } = renderApp(
			"/events?project_id=prj_1&source_id=src_1&http_status=503&provider_event_id=pi_1",
		);
		await screen.findByRole("link", { name: "evt_1" });
		await user.clear(screen.getByLabelText("Search"));
		await user.type(screen.getByLabelText("Search"), "pi_2");
		expect(router.state.location.search).toMatchObject({
			provider_event_id: "pi_1",
		});
		await user.click(screen.getByRole("button", { name: "Apply filters" }));
		await waitFor(() =>
			expect(router.state.location.search).toMatchObject({
				provider_event_id: "pi_2",
			}),
		);
		expect(seen.at(-1)?.get("provider_event_id")).toBe("pi_2");
		await user.click(screen.getByRole("button", { name: "Clear filters" }));
		await waitFor(() =>
			expect(router.state.location.search).toMatchObject({
				project_id: "prj_1",
			}),
		);
		const search = router.state.location.search as Record<string, unknown>;
		expect(search.provider_event_id).toBeUndefined();
		expect(search.http_status).toBeUndefined();
		expect(seen.at(-1)?.get("provider_event_id")).toBeNull();
		expect(seen.at(-1)?.get("http_status")).toBeNull();
		expect(seen.at(-1)?.get("project_id")).toBe("prj_1");
	});

	it("restarts pagination when filters are committed", async () => {
		const cursors: (string | null)[] = [];
		server.use(
			http.get(apiUrl("/events"), ({ request }) => {
				const cursor = new URL(request.url).searchParams.get("cursor");
				cursors.push(cursor);
				return cursor
					? HttpResponse.json({
							data: [eventSummary({ id: "evt_2" })],
							next_cursor: null,
						})
					: HttpResponse.json({ data: [eventSummary()], next_cursor: "c1" });
			}),
		);
		const { user } = renderApp("/events?project_id=prj_1&source_id=src_1");
		await user.click(await screen.findByRole("button", { name: "Load more" }));
		expect(await screen.findByRole("link", { name: "evt_2" })).toBeInTheDocument();
		await user.type(screen.getByLabelText("Search"), "pi_9{Enter}");
		await waitFor(() =>
			expect(cursors.at(-1)).toBeNull(),
		);
		expect(cursors.length).toBeGreaterThan(2);
		await waitFor(() =>
			expect(screen.queryByRole("link", { name: "evt_2" })).toBeNull(),
		);
	});

	it("clears source and destination when the project changes", async () => {
		const seen: URLSearchParams[] = [];
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({
					data: [
						project({ id: "prj_1", name: "Payments" }),
						project({ id: "prj_2", name: "Ledger" }),
					],
					next_cursor: null,
				}),
			),
			http.get(apiUrl("/events"), ({ request }) => {
				seen.push(new URL(request.url).searchParams);
				return HttpResponse.json({ data: [], next_cursor: null });
			}),
		);
		const { user, router } = renderApp(
			"/events?project_id=prj_1&source_id=src_1&destination_id=dst_1",
		);
		await screen.findByLabelText("Project");
		await user.click(screen.getByLabelText("Project"));
		await user.click(await screen.findByRole("option", { name: "Ledger" }));
		await waitFor(() =>
			expect(router.state.location.search).toMatchObject({
				project_id: "prj_2",
			}),
		);
		await waitFor(() =>
			expect(seen.at(-1)?.has("source_id")).toBe(false),
		);
		expect(seen.at(-1)?.has("destination_id")).toBe(false);
	});

	it("uses named pickers, latest-delivery wording, and real resource links", async () => {
		server.use(
			http.get(apiUrl("/events"), () =>
				HttpResponse.json({ data: [eventSummary()], next_cursor: null }),
			),
		);
		renderApp("/events");
		expect(await screen.findByRole("link", { name: "evt_1" })).toBeInTheDocument();
		expect(screen.getByLabelText("Source")).toBeInTheDocument();
		expect(screen.getByLabelText("Destination")).toBeInTheDocument();
		expect(
			screen.getByRole("columnheader", { name: "Latest delivery status" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("columnheader", { name: "Latest destination" }),
		).toBeInTheDocument();
		expect(screen.getAllByText(/latest delivery/i).length).toBeGreaterThanOrEqual(
			2,
		);
		expect(screen.queryByText(/last delivery/i)).toBeNull();
		const link = screen.getByRole("link", { name: "evt_1" });
		expect(link).toHaveAttribute("href", "/events/evt_1");
	});

	it("sends supported exact HTTP and time filters", async () => {
		let seen = new URLSearchParams();
		server.use(
			http.get(apiUrl("/events"), ({ request }) => {
				seen = new URL(request.url).searchParams;
				return HttpResponse.json({ data: [eventSummary()], next_cursor: null });
			}),
		);
		const from = T - 86_400_000;
		renderApp(`/events?http_status=503&from=${from}&to=${T}`);
		expect(await screen.findByRole("link", { name: "evt_1" })).toBeInTheDocument();
		expect(seen.get("http_status")).toBe("503");
		expect(seen.get("from")).toBe(String(from));
		expect(seen.get("to")).toBe(String(T));
	});
});
