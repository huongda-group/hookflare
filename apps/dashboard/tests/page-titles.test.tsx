import { act, screen, waitFor } from "@testing-library/react";
import { delay, HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import { renderApp } from "./helpers/render";
import { apiUrl, DEFAULT_AUTH_STATE, server } from "./helpers/server";

beforeEach(() => {
	document.title = "Hookflare";
});

function requireSetup() {
	server.use(
		http.get(apiUrl("/auth/state"), () =>
			HttpResponse.json({ ...DEFAULT_AUTH_STATE, setup_required: true }),
		),
	);
}

test.each([
	["/", "Overview"],
	["/alerts", "Alerts"],
	["/alerts/example", "Alert details"],
	["/archives", "Archives"],
	["/audit", "Audit"],
	["/endpoints", "Endpoints"],
	["/endpoints/destinations/example", "Destination details"],
	["/endpoints/sources/example", "Source details"],
	["/events", "Events"],
	["/events/example", "Event details"],
	["/failures", "Failures"],
	["/login", "Sign in"],
	["/projects", "Projects"],
	["/projects/example", "Project details"],
	["/settings", "Settings"],
	["/setup", "Setup"],
])("sets the HTML title on direct entry to %s", async (path, label) => {
	if (path === "/setup") requireSetup();
	server.use(
		...["alerts", "destinations", "events", "projects", "sources"].map((name) =>
			http.get(apiUrl(`/${name}/example`), () =>
				HttpResponse.json({ error: "Not found" }, { status: 404 }),
			),
		),
	);
	renderApp(path);

	await waitFor(() => expect(document.title).toBe(`${label} · Hookflare`));
	expect(document.head.querySelectorAll("title")).toHaveLength(1);
});

test("updates the title on navigation and browser Back", async () => {
	const { router } = renderApp("/events");
	await waitFor(() => expect(document.title).toBe("Events · Hookflare"));

	await act(() => router.navigate({ to: "/projects" }));
	await waitFor(() => expect(document.title).toBe("Projects · Hookflare"));

	act(() => router.history.back());
	await waitFor(() => expect(document.title).toBe("Events · Hookflare"));
	expect(document.head.querySelectorAll("title")).toHaveLength(1);
});

test("sets the detail title while the event request is pending", async () => {
	server.use(
		http.get(apiUrl("/events/example"), async () => {
			await delay("infinite");
			return HttpResponse.json({});
		}),
	);
	renderApp("/events/example");

	await screen.findByRole("status", { name: "Loading" });
	expect(document.title).toBe("Event details · Hookflare");
});

test("uses the destination title after a setup redirect", async () => {
	requireSetup();
	renderApp("/events");

	await screen.findByRole("heading", { name: "Set up your instance" });
	expect(document.title).toBe("Setup · Hookflare");
});

test.each(["/missing-page", "/events/example/extra"])(
	"restores the fallback title for the unmatched path %s",
	async (path) => {
		const { router } = renderApp("/events");
		await waitFor(() => expect(document.title).toBe("Events · Hookflare"));

		act(() => router.history.push(path));
		await waitFor(() => expect(document.title).toBe("Hookflare"));
	},
);
