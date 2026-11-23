import { QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { EventFilters } from "@/components/EventFilters";
import type { EventsSearch } from "@/pages/EventsPage";
import { createQueryClient } from "@/router";
import { destination, source } from "../helpers/fixtures";
import { apiUrl, server } from "../helpers/server";

function Harness({
	initial,
	onApply,
}: {
	initial: EventsSearch;
	onApply: (patch: Partial<EventsSearch>) => void;
}) {
	const [value, setValue] = useState<EventsSearch>(initial);
	return (
		<EventFilters
			value={value}
			onApply={(patch) => {
				onApply(patch);
				setValue((v) => ({ ...v, ...patch }));
			}}
		/>
	);
}

async function renderFilters(initial: Partial<EventsSearch> = {}) {
	const onApply = vi.fn();
	const qc = createQueryClient();
	const rootRoute = createRootRoute({
		component: () => (
			<QueryClientProvider client={qc}>
				<Harness
					initial={{ project_id: "prj_1", ...initial } as EventsSearch}
					onApply={onApply}
				/>
			</QueryClientProvider>
		),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	await router.load();
	const user = userEvent.setup();
	render(<RouterProvider router={router} />);
	await screen.findByLabelText("HTTP status");
	return { user, onApply };
}

describe("EventFilters", () => {
	it("rejects an out-of-range HTTP status inline, then applies a valid one on Enter", async () => {
		const { user, onApply } = await renderFilters();
		const httpInput = screen.getByLabelText("HTTP status");
		await user.type(httpInput, "700{Enter}");
		const error = await screen.findByRole("alert");
		expect(error).toHaveTextContent(
			"HTTP status must be a whole number from 100 to 599.",
		);
		expect(httpInput).toHaveAttribute("aria-invalid", "true");
		expect(httpInput).toHaveAttribute("aria-describedby", "f-http-error");
		expect(onApply).not.toHaveBeenCalled();

		await user.clear(httpInput);
		await user.type(httpInput, "503");
		expect(onApply).not.toHaveBeenCalled();
		await user.keyboard("{Enter}");
		expect(onApply).toHaveBeenLastCalledWith({
			provider_event_id: undefined,
			http_status: 503,
			from: undefined,
			to: undefined,
		});
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(httpInput).not.toHaveAttribute("aria-invalid");
	});

	it("applies empty drafts as no provider or status filter", async () => {
		const { user, onApply } = await renderFilters();
		await user.click(screen.getByRole("button", { name: "Apply filters" }));
		expect(onApply).toHaveBeenLastCalledWith({
			provider_event_id: undefined,
			http_status: undefined,
			from: undefined,
			to: undefined,
		});
	});

	it("toggles a status on and back off", async () => {
		const { user, onApply } = await renderFilters();
		const dead = screen.getByRole("button", { name: "dead" });
		await user.click(dead);
		expect(onApply).toHaveBeenLastCalledWith({ status: ["dead"] });
		expect(dead).toHaveAttribute("aria-pressed", "true");
		await user.click(dead);
		expect(onApply).toHaveBeenLastCalledWith({ status: undefined });
		expect(dead).toHaveAttribute("aria-pressed", "false");
	});

	it("commits source and destination selections immediately", async () => {
		server.use(
			http.get(apiUrl("/sources"), () =>
				HttpResponse.json({ data: [source()], next_cursor: null }),
			),
			http.get(apiUrl("/destinations"), () =>
				HttpResponse.json({ data: [destination()], next_cursor: null }),
			),
		);
		const { user, onApply } = await renderFilters();
		await user.click(screen.getByRole("combobox", { name: "Source" }));
		await user.click(await screen.findByRole("option", { name: "Stripe" }));
		expect(onApply).toHaveBeenLastCalledWith({ source_id: "src_1" });
		await user.click(screen.getByRole("combobox", { name: "Destination" }));
		await user.click(
			await screen.findByRole("option", { name: "Billing API" }),
		);
		expect(onApply).toHaveBeenLastCalledWith({ destination_id: "dst_1" });
	});

	it("drops the provider event ID when the source filter is cleared", async () => {
		server.use(
			http.get(apiUrl("/sources"), () =>
				HttpResponse.json({ data: [source()], next_cursor: null }),
			),
		);
		const { user, onApply } = await renderFilters({
			source_id: "src_1",
			provider_event_id: "evt_42",
		});
		expect(screen.getByLabelText("Search")).toHaveValue("evt_42");
		await user.click(screen.getByRole("combobox", { name: "Source" }));
		await user.click(
			await screen.findByRole("option", { name: "All sources" }),
		);
		expect(onApply).toHaveBeenLastCalledWith({
			source_id: undefined,
			provider_event_id: undefined,
		});
		expect(screen.getByLabelText("Search")).toHaveValue("");
	});

	it("keeps a typed time range as a draft until Apply", async () => {
		const { user, onApply } = await renderFilters();
		const from = screen.getByLabelText("From");
		const to = screen.getByLabelText("To");
		fireEvent.change(from, { target: { value: "2026-10-16T10:00" } });
		fireEvent.blur(from);
		fireEvent.change(to, { target: { value: "2026-10-16T12:00" } });
		fireEvent.blur(to);
		expect(onApply).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Apply filters" }));
		expect(onApply).toHaveBeenLastCalledWith({
			provider_event_id: undefined,
			http_status: undefined,
			from: Date.UTC(2026, 9, 16, 3),
			to: Date.UTC(2026, 9, 16, 5),
		});
	});
});
