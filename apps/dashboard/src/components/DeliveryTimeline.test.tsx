import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { attempt, delivery, T } from "@/test/fixtures";
import { DeliveryTimeline } from "./DeliveryTimeline";

const steps = () =>
	within(screen.getByRole("list"))
		.getAllByRole("listitem")
		.map((li) => li.getAttribute("data-step"));

const renderTimeline = (props: Parameters<typeof DeliveryTimeline>[0]) =>
	render(
		<TooltipProvider>
			<DeliveryTimeline {...props} />
		</TooltipProvider>,
	);

describe("DeliveryTimeline", () => {
	it("orders received → attempts → dead", () => {
		renderTimeline({
			receivedAt: T,
			delivery: delivery({
				status: "dead",
				attempt_count: 2,
				attempts: [
					attempt(),
					attempt({ id: "att_2", attempt_no: 2, started_at: T + 3000 }),
				],
			}),
		});
		expect(steps()).toEqual(["received", "attempt-1", "attempt-2", "dead"]);
		expect(screen.getByText("Attempt #2")).toBeInTheDocument();
		expect(screen.getAllByText("HTTP 503")).toHaveLength(2);
	});

	it("shows the next attempt while retrying", () => {
		renderTimeline({
			receivedAt: T,
			delivery: delivery({
				status: "retrying",
				completed_at: null,
				next_attempt_at: T + 60_000,
			}),
		});
		expect(steps()).toEqual(["received", "attempt-1", "retrying"]);
		expect(screen.getByText(/Retrying — next attempt/)).toBeInTheDocument();
	});

	it("labels a replay with its creator", () => {
		renderTimeline({
			receivedAt: T,
			delivery: delivery({
				kind: "replay",
				status: "delivered",
				created_by: "ops@example.com",
				attempts: [
					attempt({ http_status: 200, error_kind: null, error_message: null }),
				],
			}),
		});
		expect(screen.getByText("replay")).toBeInTheDocument();
		expect(screen.getByText(/ops@example.com/)).toBeInTheDocument();
		expect(steps().at(-1)).toBe("delivered");
	});

	it("shows paused and queued as pending", () => {
		renderTimeline({
			receivedAt: T,
			delivery: delivery({
				status: "paused",
				attempts: [],
				completed_at: null,
			}),
		});
		expect(steps()).toEqual(["received", "pending"]);
	});

	it("shows an in-flight delivery as a pending step", () => {
		renderTimeline({
			receivedAt: T,
			delivery: delivery({
				status: "in_flight",
				attempts: [],
				completed_at: null,
			}),
		});
		expect(steps()).toEqual(["received", "in_flight"]);
		expect(
			screen.getByText(/In flight — attempt in progress/),
		).toBeInTheDocument();
	});

	it("sorts attempts chronologically", () => {
		renderTimeline({
			receivedAt: T,
			delivery: delivery({
				status: "dead",
				attempt_count: 2,
				attempts: [
					attempt({ id: "att_2", attempt_no: 2, started_at: T + 3000 }),
					attempt({ id: "att_1", attempt_no: 1, started_at: T + 1000 }),
				],
			}),
		});
		const items = within(screen.getByRole("list")).getAllByRole("listitem");
		expect(items[1]).toHaveTextContent("Attempt #1");
		expect(items[2]).toHaveTextContent("Attempt #2");
	});

	it("labels replay creation time instead of receipt", () => {
		renderTimeline({
			receivedAt: T,
			delivery: delivery({
				kind: "replay",
				status: "delivered",
				created_at: T + 60_000,
				created_by: "ops@example.com",
				attempts: [
					attempt({ http_status: 200, error_kind: null, error_message: null }),
				],
			}),
		});
		expect(screen.getByText(/created/i)).toBeInTheDocument();
		expect(screen.queryByText(/^Received$/)).not.toBeInTheDocument();
	});

	it("renders response snippets as escaped text", async () => {
		const user = userEvent.setup();
		renderTimeline({
			receivedAt: T,
			delivery: delivery({
				attempts: [
					attempt({ response_snippet: "<img src=x onerror=alert(1)>" }),
				],
			}),
		});
		await user.click(screen.getByRole("button", { name: /show response/i }));
		expect(document.querySelector("img")).toBeNull();
		expect(
			await screen.findByText("<img src=x onerror=alert(1)>", {
				exact: false,
			}),
		).toBeInTheDocument();
	});

	it("keeps collapsed histories in the DOM with headers but no attempts", () => {
		const { container } = renderTimeline({
			receivedAt: T,
			defaultOpen: false,
			delivery: delivery({
				status: "dead",
				attempts: [
					attempt(),
					attempt({ id: "att_2", attempt_no: 2, started_at: T + 3000 }),
				],
			}),
		});
		expect(container).toHaveTextContent("dlv_1");
		expect(screen.queryByText("Attempt #1")).not.toBeInTheDocument();
		expect(screen.queryByText("Attempt #2")).not.toBeInTheDocument();
	});
});
