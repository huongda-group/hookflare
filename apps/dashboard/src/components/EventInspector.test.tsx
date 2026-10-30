import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { attempt, webhookEvent } from "@/test/fixtures";
import { EventInspector } from "./EventInspector";

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
});
