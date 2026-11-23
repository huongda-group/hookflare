import { act, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import { qk } from "@/lib/queries/keys";
import { EndpointsPage, endpointsSearch } from "@/pages/EndpointsPage";
import { destination, project, source } from "../helpers/fixtures";
import { chooseProject, renderApp } from "../helpers/render";
import { apiUrl, server } from "../helpers/server";

const a = project({ id: "prj_a", name: "Payments" });
const b = project({ id: "prj_b", name: "Shipping" });
const scope = (request: Request) =>
	new URL(request.url).searchParams.get("project_id");

it("lists and creates endpoints in the active project only", async () => {
	const writes: unknown[] = [];
	server.use(
		http.get(apiUrl("/projects"), () =>
			HttpResponse.json({ data: [a, b], next_cursor: null }),
		),
		http.get(apiUrl("/sources"), ({ request }) =>
			HttpResponse.json({
				data: (scope(request) === a.id
					? [a]
					: scope(request) === b.id
						? [b]
						: [a, b]
				).map((p) =>
					source({
						id: `src_${p.id}`,
						name: `${p.name} webhook`,
						project_id: p.id,
					}),
				),
				next_cursor: null,
			}),
		),
		http.get(apiUrl("/destinations"), ({ request }) =>
			HttpResponse.json({
				data: (scope(request) === a.id ? [a] : [b]).map((p) =>
					destination({
						id: `dst_${p.id}`,
						name: `${p.name} API`,
						project_id: p.id,
					}),
				),
				next_cursor: null,
			}),
		),
		http.post(apiUrl("/sources"), async ({ request }) => {
			writes.push({ scope: scope(request), body: await request.json() });
			return HttpResponse.json(source({ project_id: a.id }), { status: 201 });
		}),
	);
	const { user } = renderApp("/endpoints?tab=sources&project_id=prj_a");
	expect(
		await screen.findByRole("link", { name: "Payments webhook" }),
	).toBeVisible();
	expect(
		screen.queryByRole("link", { name: "Shipping webhook" }),
	).not.toBeInTheDocument();
	expect(screen.queryByLabelText("Filter by project")).not.toBeInTheDocument();
	await user.click(screen.getByRole("button", { name: "New source" }));
	const dialog = within(screen.getByRole("dialog", { name: "New source" }));
	expect(dialog.queryByLabelText("Project")).not.toBeInTheDocument();
	await user.click(dialog.getByLabelText("Destination"));
	await user.click(await screen.findByRole("option", { name: "Payments API" }));
	await user.type(dialog.getByLabelText("Name"), "New webhook");
	await user.click(dialog.getByRole("button", { name: "Create" }));
	await waitFor(() =>
		expect(writes).toEqual([
			{
				scope: a.id,
				body: expect.objectContaining({
					project_id: a.id,
					destination_id: "dst_prj_a",
				}),
			},
		]),
	);
	await chooseProject(user, b.name);
	expect(
		await screen.findByRole("link", { name: "Shipping webhook" }),
	).toBeVisible();
	expect(
		screen.queryByRole("link", { name: "Payments webhook" }),
	).not.toBeInTheDocument();
});

it("refreshes the originating project when a pending endpoint action completes after a switch", async () => {
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const writes: (string | null)[] = [];
	let shippingReads = 0;
	const rowA = source({
		id: "src_a",
		name: "Payments webhook",
		project_id: a.id,
	});
	const rowB = source({
		id: "src_b",
		name: "Shipping webhook",
		project_id: b.id,
	});
	server.use(
		http.get(apiUrl("/projects"), () =>
			HttpResponse.json({ data: [a, b], next_cursor: null }),
		),
		http.get(apiUrl("/sources"), ({ request }) => {
			const shipping = scope(request) === b.id;
			if (shipping) shippingReads++;
			return HttpResponse.json({
				data: [shipping ? rowB : rowA],
				next_cursor: null,
			});
		}),
		http.patch(apiUrl("/sources/src_a"), async ({ request }) => {
			writes.push(scope(request));
			await pending;
			return HttpResponse.json({ ...rowA, status: "disabled" });
		}),
	);
	const { router, user, queryClient } = renderApp(
		"/endpoints?tab=sources&project_id=prj_a",
	);
	try {
		await screen.findByRole("link", { name: "Payments webhook" });
		await user.click(screen.getByRole("button", { name: "Actions" }));
		await user.click(await screen.findByRole("menuitem", { name: "Disable" }));
		const dialog = within(
			await screen.findByRole("dialog", { name: "Disable Payments webhook?" }),
		);
		await user.click(dialog.getByRole("button", { name: "Disable" }));
		await waitFor(() => expect(writes).toEqual([a.id]));
		await act(() =>
			router.navigate({
				to: "/endpoints",
				search: { tab: "sources", project_id: b.id },
			}),
		);
		await screen.findByRole("link", { name: "Shipping webhook" });
		finish();
		await waitFor(() =>
			expect(
				queryClient.getQueryState(qk.sources.list({ project_id: a.id }))
					?.isInvalidated,
			).toBe(true),
		);
		await waitFor(() => expect(queryClient.isFetching()).toBe(0));
		expect(shippingReads).toBe(1);
		expect(
			screen.queryByRole("link", { name: "Payments webhook" }),
		).not.toBeInTheDocument();
	} finally {
		finish();
	}
});

it("switches tabs through the URL", async () => {
	server.use(
		http.get(apiUrl("/sources"), () =>
			HttpResponse.json({ data: [source()], next_cursor: null }),
		),
	);
	const { user, router } = renderApp("/endpoints?project_id=prj_1");
	expect(await screen.findByText("No destinations yet.")).toBeVisible();
	await user.click(screen.getByRole("tab", { name: "Sources" }));
	expect(
		await screen.findByRole("link", { name: "Stripe" }),
	).toBeInTheDocument();
	expect(router.state.location.search).toEqual({
		tab: "sources",
		project_id: "prj_1",
	});
});

it("falls back to the destinations tab for an unknown tab", () => {
	expect(endpointsSearch.parse({ tab: "bogus", project_id: 7 })).toEqual({
		tab: "destinations",
		project_id: undefined,
	});
});

it("renders nothing until a project is active", () => {
	const { container } = render(
		<EndpointsPage search={{ tab: "sources" }} setSearch={() => {}} />,
	);
	expect(container).toBeEmptyDOMElement();
});
