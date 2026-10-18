import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

const batch = (o = {}) => ({
	id: "arb_1",
	kind: "events",
	day: "2026-01-02",
	status: "purged",
	with_files: true,
	part_count: 1,
	item_count: 1200,
	bytes: 2_500_000,
	workflow_instance_id: "archive-2026-02-02",
	error: null,
	created_at: 1,
	verified_at: 2,
	purged_at: 3,
	parts: [
		{
			part_no: 1,
			item_count: 1200,
			bytes: 2_500_000,
			sha256: "ab",
			first_id: "evt_a",
			last_id: "evt_z",
			downloadable: true,
		},
	],
	...o,
});

describe("Archives page", () => {
	it("lists batches and offers downloads to operators", async () => {
		server.use(
			http.get(apiUrl("/archives"), () =>
				HttpResponse.json({
					data: [
						batch(),
						batch({
							id: "arb_2",
							status: "failed",
							error: "part 1: sha256 mismatch",
							parts: [],
						}),
					],
					next_cursor: null,
				}),
			),
		);
		const user = userEvent.setup();
		renderApp("/archives", { role: "operator" });
		expect(await screen.findByText("2026-01-02")).toBeInTheDocument();
		expect(screen.getByText("part 1: sha256 mismatch")).toBeInTheDocument();
		await user.click(screen.getAllByRole("button", { name: /parts/i })[0]);
		const link = screen.getByRole("link", { name: /download part 1/i });
		expect(link).toHaveAttribute(
			"href",
			"/api/admin/v1/archives/arb_1/parts/1",
		);
	});

	it("hides downloads from viewers", async () => {
		server.use(
			http.get(apiUrl("/archives"), () =>
				HttpResponse.json({ data: [batch()], next_cursor: null }),
			),
		);
		const user = userEvent.setup();
		renderApp("/archives", { role: "viewer" });
		await user.click(await screen.findByRole("button", { name: /parts/i }));
		expect(screen.queryByRole("link", { name: /download/i })).toBeNull();
	});

	it("explains cold storage and points live data elsewhere", async () => {
		server.use(
			http.get(apiUrl("/archives"), () =>
				HttpResponse.json({ data: [batch()], next_cursor: null }),
			),
		);
		renderApp("/archives", { role: "operator" });
		expect(await screen.findByText(/cold storage/i)).toBeInTheDocument();
		expect(screen.getByText(/read-only/i)).toBeInTheDocument();
		const eventsLinks = screen.getAllByRole("link", { name: /^events$/i });
		expect(eventsLinks.some((l) => l.getAttribute("href") === "/events")).toBe(
			true,
		);
		const failuresLinks = screen.getAllByRole("link", { name: /^failures$/i });
		expect(
			failuresLinks.some((l) => l.getAttribute("href") === "/failures"),
		).toBe(true);
		expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /replay/i }),
		).not.toBeInTheDocument();
	});

	it("shows a no-files state for batches without files", async () => {
		server.use(
			http.get(apiUrl("/archives"), () =>
				HttpResponse.json({
					data: [batch({ with_files: false, part_count: 0, parts: [] })],
					next_cursor: null,
				}),
			),
		);
		renderApp("/archives", { role: "operator" });
		expect(await screen.findByText(/no files/i)).toBeInTheDocument();
	});

	it("explains why a part cannot be downloaded", async () => {
		server.use(
			http.get(apiUrl("/archives"), () =>
				HttpResponse.json({
					data: [
						batch({
							parts: [
								{
									part_no: 1,
									item_count: 1200,
									bytes: 2_500_000,
									sha256: "ab",
									first_id: "evt_a",
									last_id: "evt_z",
									downloadable: false,
								},
							],
						}),
					],
					next_cursor: null,
				}),
			),
		);
		const user = userEvent.setup();
		renderApp("/archives", { role: "operator" });
		await user.click(await screen.findByRole("button", { name: /parts/i }));
		expect(
			await screen.findByText(/download unavailable/i),
		).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /download/i })).toBeNull();
	});

	it("distinguishes an empty archive from a failed load", async () => {
		renderApp("/archives", { role: "operator" });
		expect(await screen.findByText(/no archive batches/i)).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("shows a retryable error when the list fails", async () => {
		server.use(
			http.get(apiUrl("/archives"), () => new HttpResponse(null, { status: 500 })),
		);
		renderApp("/archives", { role: "operator" });
		expect(
			await screen.findByRole("button", { name: /retry/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("alert")).toBeInTheDocument();
	});

	it("keeps day grouping and rows when the next page fails", async () => {
		let calls = 0;
		server.use(
			http.get(apiUrl("/archives"), () => {
				calls += 1;
				if (calls === 1)
					return HttpResponse.json({ data: [batch()], next_cursor: "c1" });
				return new HttpResponse(null, { status: 500 });
			}),
		);
		const user = userEvent.setup();
		renderApp("/archives", { role: "operator" });
		expect(await screen.findByText("2026-01-02")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /load more/i }));
		expect(
			await screen.findByRole("button", { name: /retry loading more/i }),
		).toBeInTheDocument();
		expect(screen.getByText("2026-01-02")).toBeInTheDocument();
	});
});
