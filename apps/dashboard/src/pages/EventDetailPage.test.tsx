import { screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { delivery, webhookEvent } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

const detail = (o = {}) =>
	http.get(apiUrl("/events/evt_1"), () => HttpResponse.json(webhookEvent(o)));

const { createObjectURL, revokeObjectURL } = URL;

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
		await user.click(screen.getByRole("tab", { name: /payload/i }));
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
		await screen.findByText("dlv_1");
		await user.click(screen.getByRole("tab", { name: /payload/i }));
		await user.click(
			await screen.findByRole("button", { name: "Show payload" }),
		);
		expect(await screen.findByText("<b>hi</b>")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("shows a binary payload as a notice and downloads the original bytes", async () => {
		const blobs: Blob[] = [];
		// jsdom has no object URLs; capture the Blob handed to Download.
		Object.assign(URL, {
			createObjectURL: (b: Blob) => {
				blobs.push(b);
				return "blob:x";
			},
			revokeObjectURL: () => {},
		});
		onTestFinished(() => {
			Object.assign(URL, { createObjectURL, revokeObjectURL });
		});
		server.use(
			detail({ content_type: "application/octet-stream" }),
			http.get(
				apiUrl("/events/evt_1/payload"),
				() =>
					new HttpResponse(new Uint8Array([0xff, 0xfe, 0x00]), {
						headers: { "content-type": "application/octet-stream" },
					}),
			),
		);
		const { user } = renderApp("/events/evt_1", { role: "operator" });
		await screen.findByText("dlv_1");
		await user.click(screen.getByRole("tab", { name: /payload/i }));
		await user.click(
			await screen.findByRole("button", { name: "Show payload" }),
		);
		expect(
			await screen.findByText(/binary payload \(3 bytes\)/i),
		).toBeInTheDocument();
		const payloadSection = screen
			.getByText("Payload")
			.closest("section") as HTMLElement;
		expect(
			within(payloadSection).queryByRole("list", { name: "JSON" }),
		).toBeNull();
		await user.click(
			within(payloadSection).getByRole("button", { name: "Download" }),
		);
		expect(blobs).toHaveLength(1);
		expect(blobs[0].type).toBe("application/octet-stream");
		const bytes = await new Promise<ArrayBuffer>((resolve) => {
			const r = new FileReader();
			r.onload = () => resolve(r.result as ArrayBuffer);
			r.readAsArrayBuffer(blobs[0]);
		});
		expect([...new Uint8Array(bytes)]).toEqual([0xff, 0xfe, 0x00]);
	});

	it("shows payload_missing as no longer available", async () => {
		server.use(
			detail(),
			http.get(apiUrl("/events/evt_1/payload"), () =>
				HttpResponse.json({ error: "payload_missing" }, { status: 404 }),
			),
		);
		const { user } = renderApp("/events/evt_1", { role: "operator" });
		await screen.findByText("dlv_1");
		await user.click(screen.getByRole("tab", { name: /payload/i }));
		await user.click(screen.getByRole("button", { name: "Show payload" }));
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

	it("places deliveries before the inspector in the DOM", async () => {
		server.use(detail());
		renderApp("/events/evt_1", { role: "operator" });
		const deliveries = await screen.findByRole("heading", {
			name: /deliveries/i,
		});
		const inspector = await screen.findByRole("heading", {
			name: /request inspector|inspector/i,
		});
		expect(
			deliveries.compareDocumentPosition(inspector) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("expands the newest delivery and collapses older ones", async () => {
		server.use(
			detail({
				deliveries: [
					delivery(),
					delivery({
						id: "dlv_2",
						created_at: delivery().created_at + 60_000,
					}),
				],
			}),
		);
		const { user } = renderApp("/events/evt_1", { role: "operator" });
		await screen.findByText("dlv_2");
		// Newest delivery's attempts are visible; older delivery keeps its
		// header in the DOM but hides its attempts until expanded.
		expect(screen.getByText("Attempt #1")).toBeInTheDocument();
		const older = screen.getByRole("region", { name: /dlv_1/i });
		expect(within(older).queryByText("Attempt #1")).not.toBeInTheDocument();
		await user.click(
			within(older).getByRole("button", { name: /dlv_1|expand|show/i }),
		);
		expect(within(older).getByText("Attempt #1")).toBeInTheDocument();
	});

	it("labels replay creation time instead of a second receipt", async () => {
		server.use(
			detail({
				deliveries: [
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
		renderApp("/events/evt_1", { role: "operator" });
		const replay = await screen.findByRole("region", { name: /dlv_2/i });
		expect(within(replay).getByText(/created/i)).toBeInTheDocument();
		expect(within(replay).queryByText(/^Received$/)).not.toBeInTheDocument();
	});

	it("fetches the payload once per explicit open, never on tab switch", async () => {
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
		await user.click(screen.getByRole("tab", { name: /payload/i }));
		expect(loads).toBe(0);
		await user.click(screen.getByRole("tab", { name: /headers/i }));
		expect(loads).toBe(0);
		await user.click(screen.getByRole("tab", { name: /payload/i }));
		expect(loads).toBe(0);
		await user.click(screen.getByRole("button", { name: "Show payload" }));
		const payloadSection = screen.getByRole("tabpanel");
		expect(
			await within(payloadSection).findByRole("list", { name: "JSON" }),
		).toBeInTheDocument();
		expect(loads).toBe(1);
		await user.click(
			within(payloadSection).getByRole("button", { name: "Raw" }),
		);
		await user.click(
			within(payloadSection).getByRole("button", { name: "Tree" }),
		);
		expect(loads).toBe(1);
	});

	it("disables Replay after a confirmed missing payload", async () => {
		server.use(
			detail(),
			http.get(apiUrl("/events/evt_1/payload"), () =>
				HttpResponse.json({ error: "payload_missing" }, { status: 404 }),
			),
		);
		const { user } = renderApp("/events/evt_1", { role: "operator" });
		await screen.findByText("dlv_1");
		await user.click(screen.getByRole("tab", { name: /payload/i }));
		await user.click(screen.getByRole("button", { name: "Show payload" }));
		expect(
			await screen.findByText(/payload no longer available/i),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /replay/i })).toBeDisabled();
		expect(screen.getByText(/replay needs the payload/i)).toBeInTheDocument();
	});

	it("offers an explicit Retry for a transient payload failure", async () => {
		let loads = 0;
		server.use(
			detail(),
			http.get(apiUrl("/events/evt_1/payload"), () => {
				loads++;
				return loads === 1
					? HttpResponse.json({ error: "internal" }, { status: 503 })
					: HttpResponse.text('{"a":1}', {
							headers: { "content-type": "application/json" },
						});
			}),
		);
		const { user } = renderApp("/events/evt_1", { role: "operator" });
		await screen.findByText("dlv_1");
		await user.click(screen.getByRole("tab", { name: /payload/i }));
		await user.click(screen.getByRole("button", { name: "Show payload" }));
		await user.click(await screen.findByRole("button", { name: "Retry" }));
		const payloadSection = screen.getByRole("tabpanel");
		expect(
			await within(payloadSection).findByRole("list", { name: "JSON" }),
		).toBeInTheDocument();
		expect(loads).toBe(2);
	});
});
