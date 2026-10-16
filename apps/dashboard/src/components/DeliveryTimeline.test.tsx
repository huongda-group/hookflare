import { render, screen, within } from "@testing-library/react";
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
});
