import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { T } from "@/test/fixtures";
import { DirtyFormGuard } from "./DirtyFormGuard";
import { EmptyState } from "./EmptyState";
import { FormSection } from "./FormSection";
import { IdText } from "./IdText";
import { PageHeader } from "./PageHeader";
import { StatusBadge } from "./StatusBadge";
import { TimeText } from "./TimeText";

/** Escapes a literal string for use inside a RegExp matcher. */
function escapeRe(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Dispatches a cancelable unload event and reports whether it was blocked. */
function unloadBlocked() {
	const event = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// Spec §4: the eight delivery statuses. `active`/`disabled` are resource
// states that StatusBadge must keep supporting (spec §5).
const DELIVERY_STATUSES = [
	"pending",
	"queued",
	"in_flight",
	"retrying",
	"paused",
	"delivered",
	"failed_final",
	"dead",
] as const;

describe("StatusBadge", () => {
	it("gives every delivery status a distinct readable label", () => {
		const { container } = render(
			<>
				{DELIVERY_STATUSES.map((status) => (
					<StatusBadge key={status} status={status} />
				))}
			</>,
		);
		const badges = [...container.querySelectorAll("[data-status]")];
		expect(badges).toHaveLength(DELIVERY_STATUSES.length);

		const labels = badges.map((b) => b.textContent?.trim() ?? "");
		// A raw token like "failed_final" is not a human label.
		for (const label of labels) {
			expect(label).not.toMatch(/_/);
			expect(label).toMatch(/^[A-Z]/);
		}
		expect(new Set(labels).size).toBe(DELIVERY_STATUSES.length);
	});

	it("does not depend on color alone for the two terminal failures", () => {
		const { container } = render(
			<>
				<StatusBadge status="failed_final" />
				<StatusBadge status="dead" />
			</>,
		);
		const [failedFinal, dead] = [
			...container.querySelectorAll("[data-status]"),
		];
		// Distinct text and a distinct non-color signal (icon) even when the
		// badge colors are identical.
		expect(failedFinal.textContent?.trim()).not.toBe(dead.textContent?.trim());
		expect(failedFinal.querySelector("svg")).not.toBeNull();
		expect(dead.querySelector("svg")).not.toBeNull();
		expect(failedFinal.querySelector("svg")?.outerHTML).not.toBe(
			dead.querySelector("svg")?.outerHTML,
		);
	});

	it("keeps the resource states active and disabled working", () => {
		render(
			<>
				<StatusBadge status="active" />
				<StatusBadge status="disabled" />
			</>,
		);
		expect(screen.getByText("Active")).toBeInTheDocument();
		expect(screen.getByText("Disabled")).toBeInTheDocument();
	});
});

describe("IdText", () => {
	it("surfaces an actionable explanation instead of a false success", async () => {
		const success = vi.spyOn(toast, "success");
		const user = userEvent.setup();
		const writeText = vi.fn().mockRejectedValue(new Error("denied"));
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		render(<IdText id="dlv_1" />);

		await user.click(screen.getByRole("button", { name: "Copy dlv_1" }));

		expect(
			await screen.findByText(/could not copy automatically/i),
		).toBeInTheDocument();
		expect(writeText).toHaveBeenCalledWith("dlv_1");
		expect(success).not.toHaveBeenCalled();
		// The value stays on screen and selectable, so the user can copy it
		// without the clipboard API.
		expect(screen.getByText("dlv_1")).toBeInTheDocument();
	});

	it("confirms a successful copy", async () => {
		const success = vi.spyOn(toast, "success");
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		render(<IdText id="evt_1" />);

		await user.click(screen.getByRole("button", { name: "Copy evt_1" }));

		expect(writeText).toHaveBeenCalledWith("evt_1");
		expect(success).toHaveBeenCalledWith("Copied");
		expect(screen.queryByText(/could not copy/i)).not.toBeInTheDocument();
	});
});

describe("TimeText", () => {
	const local = formatAbsolute(T);
	const utc = new Date(T).toLocaleString("en-GB", {
		dateStyle: "medium",
		timeStyle: "medium",
		timeZone: "UTC",
	});

	it("reveals the browser-local time and an explicit UTC time on focus", async () => {
		const user = userEvent.setup();
		render(
			<TooltipProvider>
				<TimeText ms={T} />
			</TooltipProvider>,
		);
		expect(local).not.toBe(utc);
		expect(
			screen.queryByText(new RegExp(escapeRe(utc))),
		).not.toBeInTheDocument();

		await user.tab();

		expect(
			await screen.findByText(new RegExp(escapeRe(local))),
		).toBeInTheDocument();
		expect(
			screen.getByText(new RegExp(escapeRe(utc))),
		).toBeInTheDocument();
		expect(screen.getByText(/UTC/)).toBeInTheDocument();
	});

	it("reveals the same detail by click", async () => {
		const user = userEvent.setup();
		render(
			<TooltipProvider>
				<TimeText ms={T} />
			</TooltipProvider>,
		);
		const trigger = screen
			.getByText(formatRelative(T))
			.closest("button") as HTMLElement;
		expect(trigger).not.toBeNull();

		await user.click(trigger);

		expect(
			await screen.findByText(new RegExp(escapeRe(utc))),
		).toBeInTheDocument();
	});

	it("keeps the placeholder for a missing time", () => {
		render(<TimeText ms={null} />);
		expect(screen.getByText("—")).toBeInTheDocument();
	});
});

describe("PageHeader", () => {
	it("renders exactly one h1 with title, description, actions, and children", () => {
		render(
			<PageHeader
				title="Events"
				description="Every received webhook"
				actions={<button type="button">Refresh</button>}
			>
				<p>Filter bar</p>
			</PageHeader>,
		);
		const headings = screen.getAllByRole("heading", { level: 1 });
		expect(headings).toHaveLength(1);
		expect(headings[0]).toHaveTextContent("Events");
		expect(screen.getByText("Every received webhook")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
		expect(screen.getByText("Filter bar")).toBeInTheDocument();
	});
});

describe("EmptyState", () => {
	it("shows the title, explanation, and next step", () => {
		render(
			<EmptyState
				title="No events received"
				description="Create a source to start receiving webhooks."
				action={<button type="button">Create source</button>}
			/>,
		);
		expect(screen.getByText("No events received")).toBeInTheDocument();
		expect(
			screen.getByText("Create a source to start receiving webhooks."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Create source" }),
		).toBeInTheDocument();
	});
});

describe("FormSection", () => {
	it("labels its content with a section heading", () => {
		render(
			<FormSection title="Delivery policy" description="Inherited per field">
				<label htmlFor="timeout">Timeout</label>
				<input id="timeout" />
			</FormSection>,
		);
		expect(
			screen.getByRole("heading", { level: 2, name: "Delivery policy" }),
		).toBeInTheDocument();
		expect(screen.getByText("Inherited per field")).toBeInTheDocument();
		expect(screen.getByLabelText("Timeout")).toBeInTheDocument();
	});
});

describe("DirtyFormGuard", () => {
	it("does not prompt or guard unload when clean", async () => {
		const user = userEvent.setup();
		renderNavHarness({ initialDirty: false });
		await screen.findByText("Editor");
		expect(unloadBlocked()).toBe(false);

		await user.click(screen.getByRole("button", { name: "Go other" }));

		expect(await screen.findByText("Other page")).toBeInTheDocument();
		expect(
			screen.queryByText("Discard unsaved changes?"),
		).not.toBeInTheDocument();
	});

	it("stays put when a dirty navigation is canceled", async () => {
		const user = userEvent.setup();
		const { router } = renderNavHarness({ initialDirty: true });
		await screen.findByText("Editor");

		await user.click(screen.getByRole("button", { name: "Go other" }));
		expect(
			await screen.findByText("Discard unsaved changes?"),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Keep editing" }));

		expect(screen.getByText("Editor")).toBeInTheDocument();
		expect(screen.queryByText("Other page")).not.toBeInTheDocument();
		expect(router.state.location.pathname).toBe("/");
	});

	it("navigates after a dirty navigation is confirmed", async () => {
		const user = userEvent.setup();
		renderNavHarness({ initialDirty: true });
		await screen.findByText("Editor");

		await user.click(screen.getByRole("button", { name: "Go other" }));
		await screen.findByText("Discard unsaved changes?");
		await user.click(screen.getByRole("button", { name: "Discard changes" }));

		expect(await screen.findByText("Other page")).toBeInTheDocument();
	});

	it("warns before a dirty close request and closes on discard", async () => {
		const user = userEvent.setup();
		renderNavHarness({ initialDirty: true });
		await screen.findByText("Editor");

		await user.click(screen.getByRole("button", { name: "Request close" }));
		await screen.findByText("Discard unsaved changes?");
		expect(screen.queryByText("Editor closed")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		expect(await screen.findByText("Editor closed")).toBeInTheDocument();
	});

	it("closes without a prompt once a successful save clears dirty", async () => {
		const user = userEvent.setup();
		renderNavHarness({ initialDirty: true });
		await screen.findByText("Editor");

		await user.click(screen.getByRole("button", { name: "Save then close" }));

		expect(await screen.findByText("Editor closed")).toBeInTheDocument();
		expect(
			screen.queryByText("Discard unsaved changes?"),
		).not.toBeInTheDocument();
		// Dirty is gone, so the unload guard is gone with it.
		expect(unloadBlocked()).toBe(false);
	});

	it("guards unload while dirty and unregisters on unmount", async () => {
		const { unmount } = renderNavHarness({ initialDirty: true });
		await screen.findByText("Editor");
		expect(unloadBlocked()).toBe(true);

		unmount();

		expect(unloadBlocked()).toBe(false);
	});
});

/** Two routes with a guarded editor, so a real blocker can be exercised. */
function renderNavHarness({ initialDirty }: { initialDirty: boolean }) {
	const rootRoute = createRootRoute({ component: () => <Outlet /> });
	const goOther = () => void router.navigate({ to: "/audit" });
	const indexRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => (
			<EditorRoute initialDirty={initialDirty} onGoOther={goOther} />
		),
	});
	const otherRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/audit",
		component: () => <p>Other page</p>,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([indexRoute, otherRoute]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const view = render(<RouterProvider router={router} />);
	return { router, unmount: view.unmount };
}

function EditorRoute({
	initialDirty,
	onGoOther,
}: {
	initialDirty: boolean;
	onGoOther: () => void;
}) {
	const [dirty, setDirty] = React.useState(initialDirty);
	const [closed, setClosed] = React.useState(false);
	return (
		<div>
			<p>Editor</p>
			<button type="button" onClick={onGoOther}>
				Go other
			</button>
			<DirtyFormGuard dirty={dirty}>
				{(requestClose) => (
					<>
						<button
							type="button"
							onClick={() => requestClose(() => setClosed(true))}
						>
							Request close
						</button>
						<button
							type="button"
							onClick={() => {
								setDirty(false);
								requestClose(() => setClosed(true));
							}}
						>
							Save then close
						</button>
						{closed && <p>Editor closed</p>}
					</>
				)}
			</DirtyFormGuard>
		</div>
	);
}

describe("sonner Toaster", () => {
	it("stays on the fixed light theme even when the OS prefers dark", async () => {
		vi.stubGlobal(
			"matchMedia",
			vi.fn().mockImplementation((query: string) => ({
				matches: query.includes("prefers-color-scheme: dark"),
				media: query,
				onchange: null,
				addListener() {},
				removeListener() {},
				addEventListener() {},
				removeEventListener() {},
				dispatchEvent: () => false,
			})),
		);
		render(<Toaster />);
		// sonner only mounts the themed toast list once a toast exists, and adds
		// it on a macrotask, so the theme is only observable after it settles.
		await act(async () => {
			toast.success("Saved");
		});
		await waitFor(() => {
			expect(
				document.querySelector('[data-sonner-theme="light"]'),
			).not.toBeNull();
		});
	});
});
