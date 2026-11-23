import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { PayloadPanel } from "@/components/PayloadPanel";
import { apiUrl, server } from "../helpers/server";

function renderPanel(props?: {
	onMissing?: () => void;
	contentType?: string | null;
}) {
	// Plain client: framework defaults apply, so the component itself must
	// disable background retries for the audited payload read.
	const queryClient = new QueryClient();
	const user = userEvent.setup();
	render(
		<QueryClientProvider client={queryClient}>
			<PayloadPanel
				projectId="prj_1"
				eventId="evt_1"
				contentType={
					props && "contentType" in props
						? (props.contentType ?? null)
						: "application/json"
				}
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
				return HttpResponse.json({ error: "payload_missing" }, { status: 404 });
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

describe("PayloadPanel content type", () => {
	it.each([
		["the event's stored type", "text/plain", "text/plain"],
		["no type at all", null, ""],
	])(
		"types a download with %s when the response has none",
		async (_label, stored, expected) => {
			const blobs: Blob[] = [];
			const create = vi
				.spyOn(URL, "createObjectURL")
				.mockImplementation((b) => {
					blobs.push(b as Blob);
					return "blob:test";
				});
			const revoke = vi
				.spyOn(URL, "revokeObjectURL")
				.mockImplementation(() => {});
			const click = vi
				.spyOn(HTMLAnchorElement.prototype, "click")
				.mockImplementation(() => {});
			try {
				server.use(
					http.get(
						apiUrl("/events/evt_1/payload"),
						() => new HttpResponse(new TextEncoder().encode("a=1")),
					),
				);
				const { user } = renderPanel({ contentType: stored });
				await user.click(screen.getByRole("button", { name: "Show payload" }));
				expect(await screen.findByText("a=1")).toBeInTheDocument();
				await user.click(screen.getByRole("button", { name: "Download" }));
				expect(blobs).toHaveLength(1);
				expect(blobs[0].type).toBe(expected);
				expect(await blobs[0].text()).toBe("a=1");
			} finally {
				create.mockRestore();
				revoke.mockRestore();
				click.mockRestore();
			}
		},
	);
});
