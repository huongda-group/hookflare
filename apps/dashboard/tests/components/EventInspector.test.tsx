import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EventInspector } from "@/components/EventInspector";
import { attempt, webhookEvent } from "../helpers/fixtures";

describe("EventInspector", () => {
	it("shows a transport error without inventing an HTTP response or response headers", () => {
		render(
			<EventInspector
				event={webhookEvent()}
				attempt={attempt({
					http_status: null,
					error_kind: "timeout",
					response_snippet: null,
				})}
				canReadPayload={false}
				onPayloadMissing={vi.fn()}
			/>,
		);
		expect(screen.getByRole("tabpanel")).toHaveTextContent("timeout");
		expect(screen.getByRole("tabpanel")).toHaveTextContent(
			"Response snippet unavailable",
		);
		expect(screen.getByRole("tabpanel")).not.toHaveTextContent("HTTP 503");
	});

	it("renders HTML-like response snippets as inert text", () => {
		render(
			<EventInspector
				event={webhookEvent()}
				attempt={attempt({
					response_snippet: "<script>window.hacked=true</script>",
				})}
				canReadPayload={false}
				onPayloadMissing={vi.fn()}
			/>,
		);
		expect(screen.getByRole("tabpanel")).toHaveTextContent(
			"<script>window.hacked=true</script>",
		);
		expect(document.querySelector("script")).toBeNull();
	});

	it("labels accepted request headers separately from outbound response", async () => {
		const user = userEvent.setup();
		render(
			<EventInspector
				event={webhookEvent({ headers: { authorization: "[REDACTED]" } })}
				attempt={attempt({ response_snippet: "plain response" })}
				canReadPayload={false}
				onPayloadMissing={vi.fn()}
			/>,
		);
		expect(screen.getByRole("tabpanel")).toHaveTextContent("plain response");
		await user.click(screen.getByRole("tab", { name: "Request headers" }));
		expect(screen.getByRole("tabpanel")).toHaveTextContent(
			"Accepted event request headers",
		);
		expect(screen.getByRole("tabpanel")).toHaveTextContent("[REDACTED]");
	});
	it("explains a delivery with no attempts and a missing payload permission", async () => {
		const user = userEvent.setup();
		render(
			<EventInspector
				event={webhookEvent({ provider_event_id: null, content_type: null })}
				deliveryId="dlv_1"
				attempt={null}
				canReadPayload={false}
				onPayloadMissing={vi.fn()}
			/>,
		);
		expect(
			screen.getByText(/Delivery dlv_1 · No attempts yet/),
		).toBeInTheDocument();
		expect(screen.getByRole("tabpanel")).toHaveTextContent(
			"No attempt is available for inspection.",
		);
		expect(screen.getByText("—")).toBeInTheDocument();
		expect(screen.getByText(/unknown type/)).toBeInTheDocument();
		await user.click(screen.getByRole("tab", { name: "Payload" }));
		expect(screen.getByRole("tab", { name: "Payload" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByRole("tabpanel")).toHaveTextContent(
			"requires the payload.read permission",
		);
	});

	it("names the selected attempt and falls back when the transport error is unknown", () => {
		render(
			<EventInspector
				event={webhookEvent()}
				deliveryId="dlv_1"
				attempt={attempt({
					attempt_no: 3,
					http_status: null,
					error_kind: null,
					error_message: null,
				})}
				canReadPayload={false}
				onPayloadMissing={vi.fn()}
			/>,
		);
		expect(
			screen.getByText(/Delivery dlv_1 · Selected attempt 3/),
		).toBeInTheDocument();
		const summary = screen.getByText("No HTTP response");
		expect(summary.textContent).toBe("No HTTP response");
	});
});
