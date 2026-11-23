import { renderHook, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alertLinkScope, useActiveProject } from "@/lib/project-selection";
import {
	alert,
	destination,
	project,
	source,
	webhookEvent,
} from "../helpers/fixtures";
import { chooseProject, renderApp } from "../helpers/render";
import { apiUrl, server } from "../helpers/server";

const a = project({ id: "prj_a", name: "Payments" });
const b = project({ id: "prj_b", name: "Payments", status: "disabled" });
const key = "hookflare.activeProjectId";
const picker = () => screen.findByRole("combobox", { name: "Active project" });

afterEach(() => {
	window.localStorage.removeItem(key);
});

function catalog(aPage = [a, b]) {
	server.use(
		http.get(apiUrl("/projects"), () =>
			HttpResponse.json({ data: aPage, next_cursor: null }),
		),
	);
}

it.each([
	[
		"explicit URL over storage, including disabled projects",
		"/?project_id=prj_b",
		a.id,
		b.id,
	],
	["remembered selection", "/", b.id, b.id],
	["first project when storage is stale", "/", "prj_gone", a.id],
])(
	"resolves %s and records it in the scoped URL",
	async (_label, path, remembered, expected) => {
		catalog();
		window.localStorage.setItem(key, remembered);
		const { router } = renderApp(path);
		expect(await picker()).toHaveTextContent(`Payments (${expected})`);
		await waitFor(() =>
			expect(router.state.location.search).toMatchObject({
				project_id: expected,
			}),
		);
	},
);

it("blocks scoped requests for an invalid explicit project until a project is chosen", async () => {
	catalog();
	const requests: string[] = [];
	server.use(
		http.get(apiUrl("/overview"), ({ request }) => {
			requests.push(request.url);
			return HttpResponse.json({ error: "internal" }, { status: 500 });
		}),
	);
	const { router, user } = renderApp("/?project_id=prj_gone");
	expect(
		await screen.findByText("Choose an available project to continue."),
	).toBeInTheDocument();
	expect(requests).toEqual([]);
	expect(await picker()).toHaveTextContent("Choose a project");
	await chooseProject(user, "Payments (prj_a)");
	await waitFor(() =>
		expect(router.state.location.search).toMatchObject({ project_id: a.id }),
	);
});

it("offers both projects with the same name even across catalog pages", async () => {
	server.use(
		http.get(apiUrl("/projects"), ({ request }) => {
			const after = new URL(request.url).searchParams.get("cursor");
			return HttpResponse.json(
				after
					? { data: [b], next_cursor: null }
					: { data: [a], next_cursor: "next" },
			);
		}),
	);
	const { user, router } = renderApp("/");
	await user.click(await picker());
	const list = within(await screen.findByRole("listbox"));
	expect(
		list.getByRole("option", { name: "Payments (prj_a)", selected: true }),
	).toBeInTheDocument();
	await user.click(list.getByRole("option", { name: "Payments (prj_b)" }));
	await waitFor(() =>
		expect(router.state.location.search).toMatchObject({ project_id: b.id }),
	);
	expect(await picker()).toHaveTextContent("Payments (prj_b)");
});

it("retries a catalog failure without requesting project data early", async () => {
	let fail = true;
	server.use(
		http.get(apiUrl("/projects"), () =>
			fail
				? HttpResponse.json({ error: "internal" }, { status: 500 })
				: HttpResponse.json({ data: [a], next_cursor: null }),
		),
	);
	const { user } = renderApp("/");
	const retry = await screen.findByRole("button", { name: "Retry" });
	fail = false;
	await user.click(retry);
	expect(await picker()).toHaveTextContent(a.name);
});

it("works when browser storage is unavailable", async () => {
	catalog();
	const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
		throw new Error("storage blocked");
	});
	try {
		renderApp("/");
		expect(await picker()).toHaveTextContent("Payments (prj_a)");
	} finally {
		read.mockRestore();
	}
});

describe("alertLinkScope", () => {
	it("reads the project, deployment, and legacy scopes of an alert link", () => {
		expect(alertLinkScope(new URLSearchParams("project_id=prj_a"))).toBe(
			"project",
		);
		expect(alertLinkScope(new URLSearchParams("scope=deployment"))).toBe(
			"deployment",
		);
		expect(alertLinkScope(new URLSearchParams("scope=project"))).toBe(
			"project",
		);
		expect(alertLinkScope(new URLSearchParams(""))).toBe("legacy");
	});
});

describe("ActiveProjectContext default", () => {
	it("is inert outside the shell", () => {
		const { result } = renderHook(() => useActiveProject());
		expect(result.current.projectId).toBeUndefined();
		expect(() => result.current.selectProject("prj_a")).not.toThrow();
	});
});

describe("switching projects", () => {
	const ops = project({ id: "prj_b", name: "Ops" });
	const twoProjects = () => catalog([a, ops]);
	const details = () =>
		server.use(
			http.get(apiUrl("/sources/src_1"), () => HttpResponse.json(source())),
			http.get(apiUrl("/destinations/dst_1"), () =>
				HttpResponse.json(destination()),
			),
			http.get(apiUrl("/events/evt_1"), () =>
				HttpResponse.json(webhookEvent()),
			),
			http.get(apiUrl("/alerts/alr_1"), () =>
				HttpResponse.json({
					...alert({ project_id: "prj_a" }),
					notifications: [],
				}),
			),
		);

	it.each([
		[
			"/endpoints/sources/src_1?project_id=prj_a",
			"/endpoints",
			{ project_id: "prj_b", tab: "sources" },
		],
		[
			"/endpoints/destinations/dst_1?project_id=prj_a",
			"/endpoints",
			{ project_id: "prj_b", tab: "destinations" },
		],
		["/events/evt_1?project_id=prj_a", "/events", { project_id: "prj_b" }],
		[
			"/alerts/alr_1?project_id=prj_a",
			"/alerts",
			{ project_id: "prj_b", status: "open" },
		],
	])(
		"leaves the detail page %s for its collection",
		async (path, to, search) => {
			twoProjects();
			details();
			const { user, router } = renderApp(path);
			expect(await picker()).toHaveTextContent("Payments");
			await chooseProject(user, "Ops");
			await waitFor(() => expect(router.state.location.pathname).toBe(to));
			expect(router.state.location.search).toEqual(search);
		},
	);

	it("only remembers the choice on a page outside project scope", async () => {
		twoProjects();
		const { user, router } = renderApp("/projects");
		expect(await picker()).toHaveTextContent("Payments");
		await chooseProject(user, "Ops");
		await waitFor(() => expect(window.localStorage.getItem(key)).toBe("prj_b"));
		expect(await picker()).toHaveTextContent("Ops");
		expect(router.state.location.pathname).toBe("/projects");
		expect(router.state.location.search).toEqual({});
	});

	it("keeps failure filters when scoping, and drops the destination on a switch", async () => {
		twoProjects();
		const { user, router } = renderApp(
			"/failures?tab=failed_final&destination_id=dst_1",
		);
		await waitFor(() =>
			expect(router.state.location.search).toMatchObject({
				project_id: "prj_a",
				tab: "failed_final",
				destination_id: "dst_1",
			}),
		);
		await chooseProject(user, "Ops");
		await waitFor(() =>
			expect(router.state.location.search).toMatchObject({
				project_id: "prj_b",
				tab: "failed_final",
			}),
		);
		expect(router.state.location.search).not.toHaveProperty("destination_id");
	});

	it("keeps a resolved alert filter when scoping the alert list", async () => {
		twoProjects();
		const { router } = renderApp("/alerts?status=resolved");
		await waitFor(() =>
			expect(router.state.location.search).toMatchObject({
				project_id: "prj_a",
				status: "resolved",
			}),
		);
	});
});
