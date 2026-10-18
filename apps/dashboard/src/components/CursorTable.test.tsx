import type { Page } from "@hookflare/shared";
import { QueryClientProvider, useInfiniteQuery } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CursorTable } from "@/components/CursorTable";
import { DataState } from "@/components/DataState";
import { IdText } from "@/components/IdText";
import { ApiError, api } from "@/lib/api";
import { createQueryClient } from "@/router";
import { failure } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

type Row = { id: string; label: string };

const ROWS: Row[] = [
	{ id: "evt_1", label: "one" },
	{ id: "dlv_1", label: "two" },
];

/**
 * Drives a real infinite query through CursorTable so the loading, refresh, and
 * next-page failure paths come from TanStack Query's real flags, not mocks.
 */
function Probe({
	withSelection = false,
	withHref = true,
	max = 100,
	empty = "Nothing here.",
	emptyAction,
	onRowClick,
}: {
	withSelection?: boolean;
	withHref?: boolean;
	max?: number;
	empty?: string;
	emptyAction?: ReactNode;
	onRowClick?: (row: Row) => void;
}) {
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const query = useInfiniteQuery({
		queryKey: ["probe"],
		queryFn: ({ pageParam }) =>
			api.get<Page<Row>>("/events", { limit: 2, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});
	return (
		<div>
			<button type="button" onClick={() => void query.refetch()}>
				Refresh data
			</button>
			<p>selected:{[...selected].join(",")}</p>
			<CursorTable<Row>
				query={query}
				rowKey={(row) => row.id}
				ariaLabel="Probe table"
				empty={empty}
				emptyAction={emptyAction}
				getRowHref={withHref ? (row) => `/resource/${row.id}` : undefined}
				onRowClick={onRowClick}
				selection={
					withSelection ? { selected, onChange: setSelected, max } : undefined
				}
				columns={[
					{ header: "ID", cell: (row) => <IdText id={row.id} /> },
					{ header: "Label", cell: (row) => row.label },
				]}
			/>
		</div>
	);
}

/** Renders the probe inside a real router so `getRowHref` becomes a Router link. */
function renderProbe(node: ReactNode) {
	const queryClient = createQueryClient();
	const rootRoute = createRootRoute({ component: () => <Outlet /> });
	const indexRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => <>{node}</>,
	});
	const resourceRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/resource/$id",
		component: () => <p>Resource page</p>,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([indexRoute, resourceRoute]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const user = userEvent.setup();
	render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return { user, router, queryClient };
}

const page = (rows: Row[], next: string | null = null) =>
	HttpResponse.json({ data: rows, next_cursor: next });

describe("CursorTable data states", () => {
	it("shows an accessible loading status and no placeholder rows while pending", async () => {
		server.use(
			http.get(apiUrl("/events"), async () => {
				await delay("infinite");
				return page([]);
			}),
		);
		renderProbe(<Probe empty="No rows match." />);

		// The router mounts asynchronously, so wait for the skeleton before asserting.
		const status = await screen.findByRole("status");
		expect(status).toHaveAccessibleName(/loading/i);
		expect(screen.queryByRole("table")).not.toBeInTheDocument();
		expect(screen.queryByText("Nothing here.")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
	});

	it("treats a failed first request as a load error, never an empty state", async () => {
		let fail = true;
		server.use(
			http.get(apiUrl("/events"), () =>
				fail
					? HttpResponse.json({ error: "internal" }, { status: 500 })
					: page(ROWS),
			),
		);
		const { user } = renderProbe(<Probe empty="No rows match." />);

		expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
		expect(screen.queryByText("No rows match.")).not.toBeInTheDocument();

		fail = false;
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("one")).toBeInTheDocument();
	});

	it("keeps stale rows with a non-destructive warning when a refresh fails", async () => {
		let fail = false;
		server.use(
			http.get(apiUrl("/events"), () =>
				fail
					? HttpResponse.json({ error: "internal" }, { status: 500 })
					: page([{ id: "evt_1", label: "one" }]),
			),
		);
		const { user } = renderProbe(<Probe />);
		expect(await screen.findByText("one")).toBeInTheDocument();

		fail = true;
		await user.click(screen.getByRole("button", { name: "Refresh data" }));

		expect(await screen.findByText(/could not refresh/i)).toBeInTheDocument();
		expect(screen.getByText("one")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
		expect(screen.queryByText(/could not load/i)).not.toBeInTheDocument();
	});

	it("shows the empty message and its next action instead of a failure", async () => {
		server.use(http.get(apiUrl("/events"), () => page([])));
		renderProbe(
			<Probe
				empty="No rows match."
				emptyAction={<button type="button">Create row</button>}
			/>,
		);

		expect(await screen.findByText("No rows match.")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Create row" }),
		).toBeInTheDocument();
		expect(screen.queryByText(/could not load/i)).not.toBeInTheDocument();
	});

	it("keeps loaded rows, links, and selection when the next page fails, then retries only that page", async () => {
		let failNext = true;
		server.use(
			http.get(apiUrl("/events"), ({ request }) => {
				const cursor = new URL(request.url).searchParams.get("cursor");
				if (cursor) {
					return failNext
						? HttpResponse.json({ error: "internal" }, { status: 500 })
						: page([{ id: "evt_9", label: "nine" }]);
				}
				return page(ROWS, "c1");
			}),
		);
		const { user } = renderProbe(<Probe withSelection />);
		expect(await screen.findByText("one")).toBeInTheDocument();
		await user.click(screen.getByRole("checkbox", { name: "Select dlv_1" }));

		await user.click(screen.getByRole("button", { name: "Load more" }));

		expect(
			await screen.findByRole("button", { name: "Retry loading more" }),
		).toBeEnabled();
		// The failed next page never replaced the loaded page.
		expect(screen.getByRole("link", { name: /evt_1/ })).toBeVisible();
		expect(
			screen.getByRole("checkbox", { name: "Select dlv_1" }),
		).toBeChecked();
		expect(screen.getByText("two")).toBeInTheDocument();
		// The next-page warning is a non-fatal status, not the initial-failure alert.
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();

		failNext = false;
		await user.click(
			screen.getByRole("button", { name: "Retry loading more" }),
		);
		expect(await screen.findByText("nine")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Retry loading more" }),
		).not.toBeInTheDocument();
		// The retry appended the next page without clearing the selection.
		expect(
			screen.getByRole("checkbox", { name: "Select dlv_1" }),
		).toBeChecked();
	});

	it("Select loaded adds only loaded rows and respects the selection max", async () => {
		server.use(
			http.get(apiUrl("/events"), () =>
				page(
					[
						{ id: "r1", label: "one" },
						{ id: "r2", label: "two" },
						{ id: "r3", label: "three" },
					],
					"c1",
				),
			),
		);
		const { user } = renderProbe(<Probe withSelection max={2} />);
		await screen.findByText("one");

		await user.click(screen.getByRole("button", { name: "Select loaded" }));

		expect(screen.getByText("selected:r1,r2")).toBeInTheDocument();
	});

	it("Select loaded never includes unseen rows", async () => {
		server.use(
			http.get(apiUrl("/events"), () =>
				page(
					[
						{ id: "r1", label: "one" },
						{ id: "r2", label: "two" },
						{ id: "r3", label: "three" },
					],
					"c1",
				),
			),
		);
		const { user } = renderProbe(<Probe withSelection max={100} />);
		await screen.findByText("one");

		await user.click(screen.getByRole("button", { name: "Select loaded" }));

		expect(screen.getByText("selected:r1,r2,r3")).toBeInTheDocument();
	});

	it("hides Select loaded when the table has no selection control", async () => {
		server.use(http.get(apiUrl("/events"), () => page(ROWS)));
		renderProbe(<Probe />);
		await screen.findByText("one");

		expect(
			screen.queryByRole("button", { name: "Select loaded" }),
		).not.toBeInTheDocument();
	});

	it("does not navigate the row from its checkbox or copy control, and offers no page numbers", async () => {
		const onRowClick = vi.fn();
		server.use(http.get(apiUrl("/events"), () => page(ROWS)));
		const { user, router } = renderProbe(
			<Probe withSelection withHref={false} onRowClick={onRowClick} />,
		);
		await screen.findByText("one");

		await user.click(screen.getByRole("checkbox", { name: "Select evt_1" }));
		expect(onRowClick).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Copy evt_1" }));
		expect(onRowClick).not.toHaveBeenCalled();
		expect(router.state.location.pathname).toBe("/");

		// A pointer click on the row still works (it is not the only path).
		await user.click(screen.getByText("one"));
		expect(onRowClick).toHaveBeenCalledTimes(1);

		expect(
			screen.queryByRole("button", { name: /(next|previous) page/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /page ?\d/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /page ?\d/i }),
		).not.toBeInTheDocument();
	});

	it("gives each row a keyboard-accessible resource link on its key", async () => {
		server.use(http.get(apiUrl("/events"), () => page(ROWS)));
		const { user, router } = renderProbe(<Probe withHref />);

		const link = await screen.findByRole("link", { name: /evt_1/ });
		expect(link).toBeVisible();
		link.focus();
		expect(link).toHaveFocus();

		await user.keyboard("{Enter}");
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/resource/evt_1"),
		);
	});

	it("puts wide table content in a labeled, keyboard-focusable overflow region", async () => {
		server.use(http.get(apiUrl("/events"), () => page(ROWS)));
		renderProbe(<Probe />);
		await screen.findByText("one");

		const region = screen.getByRole("region", { name: "Probe table" });
		expect(region).toHaveAttribute("tabindex", "0");
		region.focus();
		expect(region).toHaveFocus();
	});
});

describe("DataState", () => {
	it("renders children unchanged and calls Retry only for a failure", () => {
		const onRetry = vi.fn();
		render(
			<DataState
				pending={false}
				error={null}
				hasData
				retrying={false}
				onRetry={onRetry}
			>
				<p>loaded rows</p>
			</DataState>,
		);

		expect(screen.getByText("loaded rows")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Retry" }),
		).not.toBeInTheDocument();
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("shows an initial failure panel with Retry instead of children", async () => {
		const onRetry = vi.fn();
		const user = userEvent.setup();
		render(
			<DataState
				pending={false}
				error={new ApiError(500, "internal")}
				hasData={false}
				retrying={false}
				onRetry={onRetry}
			>
				<p>loaded rows</p>
			</DataState>,
		);

		expect(screen.getByText(/could not load/i)).toBeInTheDocument();
		expect(screen.queryByText("loaded rows")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("keeps children and warns non-destructively when a refresh fails", async () => {
		const onRetry = vi.fn();
		const user = userEvent.setup();
		render(
			<DataState
				pending={false}
				error={new ApiError(500, "internal")}
				hasData
				retrying={false}
				onRetry={onRetry}
			>
				<p>loaded rows</p>
			</DataState>,
		);

		expect(screen.getByText("loaded rows")).toBeInTheDocument();
		expect(screen.getByText(/could not refresh/i)).toBeInTheDocument();
		expect(screen.queryByText(/could not load/i)).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("disables Retry while retrying", () => {
		render(
			<DataState
				pending={false}
				error={new ApiError(500, "internal")}
				hasData={false}
				retrying
				onRetry={() => {}}
			>
				<p>loaded rows</p>
			</DataState>,
		);

		expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
	});

	it("shows a labeled skeleton before the first result", () => {
		render(
			<DataState
				pending
				error={null}
				hasData={false}
				retrying={false}
				onRetry={() => {}}
			>
				<p>loaded rows</p>
			</DataState>,
		);

		expect(screen.getByRole("status")).toHaveAccessibleName(/loading/i);
		expect(screen.queryByText("loaded rows")).not.toBeInTheDocument();
	});
});

describe("Cursor pagination failures on a page", () => {
	it("keeps rows and selection and retries only the failed next page", async () => {
		let failNext = true;
		server.use(
			http.get(apiUrl("/failures"), ({ request }) => {
				const cursor = new URL(request.url).searchParams.get("cursor");
				if (cursor) {
					return failNext
						? HttpResponse.json({ error: "internal" }, { status: 500 })
						: HttpResponse.json({
								data: [failure({ id: "dlv_2" })],
								next_cursor: null,
							});
				}
				return HttpResponse.json({
					data: [failure()],
					next_cursor: "c1",
				});
			}),
		);
		const { user } = renderApp("/failures", { role: "operator" });
		expect(await screen.findByText("dlv_1")).toBeInTheDocument();
		await user.click(screen.getByRole("checkbox", { name: "Select dlv_1" }));

		await user.click(screen.getByRole("button", { name: "Load more" }));

		expect(
			await screen.findByRole("button", { name: "Retry loading more" }),
		).toBeEnabled();
		expect(screen.getByRole("link", { name: /evt_1/ })).toBeVisible();
		expect(
			screen.getByRole("checkbox", { name: "Select dlv_1" }),
		).toBeChecked();
		expect(
			screen.queryByRole("button", { name: /page ?\d/i }),
		).not.toBeInTheDocument();

		failNext = false;
		await user.click(
			screen.getByRole("button", { name: "Retry loading more" }),
		);
		expect(await screen.findByText("dlv_2")).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", { name: "Select dlv_1" }),
		).toBeChecked();
	});
});
