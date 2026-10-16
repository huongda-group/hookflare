import { screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { delivery, webhookEvent } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

const detail = (o = {}) =>
	http.get(apiUrl("/events/evt_1"), () => HttpResponse.json(webhookEvent(o)));

describe("Event Detail", () => {
	it("lists deliveries newest first", async () => {
		server.use(
			detail({
				deliveries: [
					delivery(),
					delivery({
						id: "dlv_2",
						kind: "replay",
						created_at: delivery().created_at + 60_000,
						created_by: "ops@example.com",
						status: "delivered",
					}),
				],
			}),
		);
		renderApp("/events/evt_1");
		const sections = await screen.findAllByRole("region", {
			name: /delivery/i,
		});
		expect(within(sections[0]).getByText("dlv_2")).toBeInTheDocument();
		expect(within(sections[1]).getByText("dlv_1")).toBeInTheDocument();
	});

	it("loads the payload only on click", async () => {
		let loads = 0;
		server.use(
			detail(),
			http.get(apiUrl("/events/evt_1/payload"), () => {
				loads++;
				return HttpResponse.text('{"a":1}', {
					headers: { "content-type": "application/json" },
				});
			}),
		);
		const { user } = renderApp("/events/evt_1", { role: "operator" });
		await screen.findByText("dlv_1");
		expect(loads).toBe(0);
		await user.click(screen.getByRole("button", { name: "Show payload" }));
		const payloadSection = screen.getByText("Payload").closest("section");
		expect(payloadSection).not.toBeNull();
		expect(
			await within(payloadSection as HTMLElement).findByRole("list", {
				name: "JSON",
			}),
		).toBeInTheDocument();
		expect(loads).toBe(1);
	});

	it("renders an HTML payload as text without tripping the session banner", async () => {
		server.use(
			detail({ content_type: "text/html" }),
			http.get(
				apiUrl("/events/evt_1/payload"),
				() =>
					new HttpResponse("<b>hi</b>", {
						headers: { "content-type": "text/html" },
					}),
			),
		);
		const { user } = renderApp("/events/evt_1", { role: "operator" });
		await user.click(
			await screen.findByRole("button", { name: "Show payload" }),
		);
		expect(await screen.findByText("<b>hi</b>")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("shows payload_missing as no longer available", async () => {
		server.use(
			detail(),
			http.get(apiUrl("/events/evt_1/payload"), () =>
				HttpResponse.json({ error: "payload_missing" }, { status: 404 }),
			),
		);
		const { user } = renderApp("/events/evt_1", { role: "operator" });
		await user.click(
			await screen.findByRole("button", { name: "Show payload" }),
		);
		expect(
			await screen.findByText(/payload no longer available/i),
		).toBeInTheDocument();
	});

	it("hides payload and replay from viewers", async () => {
		server.use(detail());
		renderApp("/events/evt_1", { role: "viewer" });
		await screen.findByText("dlv_1");
		expect(
			screen.queryByRole("button", { name: "Show payload" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Replay" }),
		).not.toBeInTheDocument();
	});

	it("shows an error with Retry for a non-404 failure", async () => {
		let fail = true;
		server.use(
			http.get(apiUrl("/events/evt_1"), () =>
				fail
					? HttpResponse.json({ error: "internal" }, { status: 500 })
					: HttpResponse.json(webhookEvent()),
			),
		);
		const { user } = renderApp("/events/evt_1");
		expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
		fail = false;
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(
			await screen.findByRole("heading", { name: "evt_1" }),
		).toBeInTheDocument();
	});
});
