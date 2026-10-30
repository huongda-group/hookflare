import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { apiUrl, server } from "@/test/server";
import { PayloadPanel } from "./PayloadPanel";

function renderPanel(props?: { onMissing?: () => void }) {
	// Plain client: framework defaults apply, so the component itself must
	// disable background retries for the audited payload read.
	const queryClient = new QueryClient();
	const user = userEvent.setup();
	render(
		<QueryClientProvider client={queryClient}>
			<PayloadPanel
				eventId="evt_1"
				contentType="application/json"
				size={17}
				onMissing={props?.onMissing}
			/>
		</QueryClientProvider>,
	);
	return { user };
}

const payloadCalls = (spy: ReturnType<typeof vi.spyOn>) =>
	spy.mock.calls.filter(([input]: Parameters<typeof fetch>) =>
		String(input).includes("/events/evt_1/payload"),
	);

describe("PayloadPanel request lifecycle", () => {
	it("fetches once per explicit open and never on viewer toggles", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		try {
			server.use(
				http.get(apiUrl("/events/evt_1/payload"), () =>
					HttpResponse.text('{"a":1}', {
						headers: { "content-type": "application/json" },
					}),
				),
			);
			const { user } = renderPanel();
			expect(payloadCalls(fetchSpy)).toHaveLength(0);
			await user.click(screen.getByRole("button", { name: "Show payload" }));
			expect(
				await screen.findByRole("list", { name: "JSON" }),
			).toBeInTheDocument();
			expect(payloadCalls(fetchSpy)).toHaveLength(1);
			await user.click(screen.getByRole("button", { name: "Raw" }));
			await user.click(screen.getByRole("button", { name: "Tree" }));
			expect(payloadCalls(fetchSpy)).toHaveLength(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("never retries a failed fetch in the background", async () => {
		let loads = 0;
		server.use(
			http.get(apiUrl("/events/evt_1/payload"), () => {
				loads++;
				return HttpResponse.json({ error: "internal" }, { status: 500 });
			}),
		);
		const { user } = renderPanel();
		await user.click(screen.getByRole("button", { name: "Show payload" }));
		expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
		// No background retries: exactly one read for one user action.
		expect(loads).toBe(1);
	});

	it("calls onMissing once for a confirmed missing payload", async () => {
		let loads = 0;
		server.use(
			http.get(apiUrl("/events/evt_1/payload"), () => {
				loads++;
				return HttpResponse.json(
					{ error: "payload_missing" },
					{ status: 404 },
				);
			}),
		);
		const onMissing = vi.fn();
		const { user } = renderPanel({ onMissing });
		await user.click(screen.getByRole("button", { name: "Show payload" }));
		expect(
			await screen.findByText(/payload no longer available/i),
		).toBeInTheDocument();
		expect(onMissing).toHaveBeenCalledTimes(1);
		expect(loads).toBe(1);
	});

	it("retries a transient failure only on explicit user action", async () => {
		let loads = 0;
		server.use(
			http.get(apiUrl("/events/evt_1/payload"), () => {
				loads++;
				return loads === 1
					? HttpResponse.json({ error: "internal" }, { status: 503 })
					: HttpResponse.text('{"a":1}', {
							headers: { "content-type": "application/json" },
						});
			}),
		);
		const { user } = renderPanel();
		await user.click(screen.getByRole("button", { name: "Show payload" }));
		expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
		expect(loads).toBe(1);
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(
			await screen.findByRole("list", { name: "JSON" }),
		).toBeInTheDocument();
		expect(loads).toBe(2);
	});
});
