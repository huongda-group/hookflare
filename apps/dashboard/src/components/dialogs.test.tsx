import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/router";
import { destination, project } from "@/test/fixtures";
import { apiUrl, server } from "@/test/server";
import { invalidateDeliveryViews } from "@/lib/queries/invalidate-delivery-views";
import { ConfirmDialog } from "./ConfirmDialog";
import { DestinationFormDialog } from "./DestinationFormDialog";
import { ReplayDialog } from "./ReplayDialog";
import { RotateSecretDialog } from "./RotateSecretDialog";
import { SecretRevealDialog } from "./SecretRevealDialog";

vi.mock("@/lib/queries/invalidate-delivery-views", () => ({
	invalidateDeliveryViews: vi.fn(),
}));

const wrap = (ui: ReactNode) =>
	render(
		<QueryClientProvider client={createQueryClient()}>
			{ui}
		</QueryClientProvider>,
	);

/** Outcome rows link to their event, so link-rendering tests mount inside a router. */
const wrapWithRouter = (ui: ReactNode) => {
	const qc = createQueryClient();
	const rootRoute = createRootRoute({
		component: () => (
			<QueryClientProvider client={qc}>{ui}</QueryClientProvider>
		),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	return render(<RouterProvider router={router} />);
};

describe("ReplayDialog", () => {
	it("requires a reason before sending", async () => {
		const sent = vi.fn();
		server.use(
			http.post(apiUrl("/failures/replay"), async ({ request }) => {
				sent(await request.json());
				return HttpResponse.json({ replayed: [], skipped: [] });
			}),
		);
		wrap(
			<ReplayDialog
				open
				onOpenChange={() => {}}
				target={{ kind: "bulk", deliveryIds: ["dlv_1"] }}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Replay 1" }));
		expect(await screen.findByText(/reason is required/i)).toBeInTheDocument();
		expect(sent).not.toHaveBeenCalled();
	});

	it("shows replayed, skipped, and the not-enqueued note", async () => {
		server.use(
			http.post(apiUrl("/failures/replay"), () =>
				HttpResponse.json({
					replayed: [
						{ delivery_id: "dlv_1", new_delivery_id: "dlv_9", enqueued: false },
					],
					skipped: [{ delivery_id: "dlv_2", reason: "destination_disabled" }],
				}),
			),
		);
		wrap(
			<ReplayDialog
				open
				onOpenChange={() => {}}
				target={{ kind: "bulk", deliveryIds: ["dlv_1", "dlv_2"] }}
			/>,
		);
		await userEvent.type(screen.getByLabelText("Reason"), "backend fixed");
		await userEvent.click(screen.getByRole("button", { name: "Replay 2" }));
		expect(await screen.findByText("dlv_9")).toBeInTheDocument();
		expect(screen.getByText(/destination_disabled/)).toBeInTheDocument();
		expect(
			screen.getByText(/reconciler enqueues it within a minute/i),
		).toBeInTheDocument();
	});
});

describe("ReplayDialog result", () => {
	it("keeps the sent count after the caller clears its selection", async () => {		server.use(
			http.post(apiUrl("/failures/replay"), () =>
				HttpResponse.json({
					replayed: [
						{ delivery_id: "dlv_1", new_delivery_id: "dlv_8", enqueued: true },
						{ delivery_id: "dlv_2", new_delivery_id: "dlv_9", enqueued: true },
					],
					skipped: [],
				}),
			),
		);
		function Harness() {
			const [ids, setIds] = useState(["dlv_1", "dlv_2"]);
			return (
				<ReplayDialog
					open
					onOpenChange={() => {}}
					target={{ kind: "bulk", deliveryIds: ids }}
					onDone={() => setIds([])}
				/>
			);
		}
		wrap(<Harness />);
		await userEvent.type(screen.getByLabelText("Reason"), "backend fixed");
		await userEvent.click(screen.getByRole("button", { name: "Replay 2" }));
		expect(await screen.findByText("dlv_9")).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Replay 2 deliveries" }),
		).toBeInTheDocument();
	});
});

describe("SecretRevealDialog", () => {
	it("cannot close until the user confirms storing the secret", async () => {
		const onClose = vi.fn();
		render(
			<SecretRevealDialog
				secret="whsec_abc"
				label="Signing secret"
				onClose={onClose}
			/>,
		);
		const done = screen.getByRole("button", { name: "Done" });
		expect(done).toBeDisabled();
		await userEvent.keyboard("{Escape}");
		expect(onClose).not.toHaveBeenCalled();
		await userEvent.click(screen.getByLabelText("I have stored this secret"));
		await userEvent.click(done);
		expect(onClose).toHaveBeenCalled();
	});

	it("starts unticked for every new secret, whatever closed the last one", async () => {
		const onClose = vi.fn();
		const { rerender } = render(
			<SecretRevealDialog
				secret="whsec_one"
				label="Secret"
				onClose={onClose}
			/>,
		);
		await userEvent.click(screen.getByLabelText("I have stored this secret"));
		await userEvent.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalledTimes(1);
		rerender(
			<SecretRevealDialog secret={null} label="Secret" onClose={onClose} />,
		);
		rerender(
			<SecretRevealDialog
				secret="whsec_two"
				label="Secret"
				onClose={onClose}
			/>,
		);
		expect(await screen.findByText("whsec_two")).toBeInTheDocument();
		expect(
			screen.getByLabelText("I have stored this secret"),
		).not.toBeChecked();
		expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
		await userEvent.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("resets when the secret changes without closing", async () => {
		const onClose = vi.fn();
		const { rerender } = render(
			<SecretRevealDialog
				secret="whsec_one"
				label="Secret"
				onClose={onClose}
			/>,
		);
		await userEvent.click(screen.getByLabelText("I have stored this secret"));
		rerender(
			<SecretRevealDialog
				secret="whsec_two"
				label="Secret"
				onClose={onClose}
			/>,
		);
		expect(
			screen.getByLabelText("I have stored this secret"),
		).not.toBeChecked();
	});
});

describe("RotateSecretDialog", () => {
	it("warns when grace_hours is 0", async () => {
		wrap(
			<RotateSecretDialog
				open
				onOpenChange={() => {}}
				resource="destination"
				id="dst_1"
				onRotated={() => {}}
			/>,
		);
		expect(
			screen.queryByText(/revokes the current secret immediately/i),
		).not.toBeInTheDocument();
		const grace = screen.getByLabelText("Grace period (hours)");
		await userEvent.clear(grace);
		await userEvent.type(grace, "0");
		expect(
			await screen.findByText(/revokes the current secret immediately/i),
		).toBeInTheDocument();
	});

	it("returns the new secret", async () => {
		server.use(
			http.post(apiUrl("/destinations/dst_1/rotate-secret"), () =>
				HttpResponse.json({ id: "dst_1", signing_secret: "whsec_new" }),
			),
		);
		const onRotated = vi.fn();
		wrap(
			<RotateSecretDialog
				open
				onOpenChange={() => {}}
				resource="destination"
				id="dst_1"
				onRotated={onRotated}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Rotate" }));
		await waitFor(() => expect(onRotated).toHaveBeenCalledWith("whsec_new"));
	});

	it("masks the supplied secret and clears every field after cancel", async () => {
		const { rerender } = wrap(
			<RotateSecretDialog
				open
				onOpenChange={() => {}}
				resource="source"
				id="src_1"
				onRotated={() => {}}
			/>,
		);
		const supplied = screen.getByLabelText(/New secret/);
		expect(supplied).toHaveAttribute("type", "password");
		expect(supplied).toHaveAttribute("autocomplete", "off");
		await userEvent.type(supplied, "a-very-long-secret-value");
		await userEvent.type(screen.getByLabelText("Reason (optional)"), "leak");
		const grace = screen.getByLabelText("Grace period (hours)");
		await userEvent.clear(grace);
		await userEvent.type(grace, "2");
		const props = {
			onOpenChange: () => {},
			resource: "source" as const,
			id: "src_1",
			onRotated: () => {},
		};
		const client = createQueryClient();
		rerender(
			<QueryClientProvider client={client}>
				<RotateSecretDialog open={false} {...props} />
			</QueryClientProvider>,
		);
		rerender(
			<QueryClientProvider client={client}>
				<RotateSecretDialog open {...props} />
			</QueryClientProvider>,
		);
		expect(await screen.findByLabelText(/New secret/)).toHaveValue("");
		expect(screen.getByLabelText("Reason (optional)")).toHaveValue("");
		expect(screen.getByLabelText("Grace period (hours)")).toHaveValue(24);
	});

	it("clears the supplied secret after a successful rotation", async () => {
		server.use(
			http.post(apiUrl("/sources/src_1/rotate-secret"), () =>
				HttpResponse.json({ id: "src_1" }),
			),
		);
		function Harness() {
			const [open, setOpen] = useState(true);
			return (
				<>
					<button type="button" onClick={() => setOpen(true)}>
						reopen
					</button>
					<RotateSecretDialog
						open={open}
						onOpenChange={setOpen}
						resource="source"
						id="src_1"
						onRotated={() => {}}
					/>
				</>
			);
		}
		wrap(<Harness />);
		await userEvent.type(
			screen.getByLabelText(/New secret/),
			"a-very-long-secret-value",
		);
		await userEvent.click(screen.getByRole("button", { name: "Rotate" }));
		await waitFor(() =>
			expect(screen.queryByLabelText(/New secret/)).not.toBeInTheDocument(),
		);
		await userEvent.click(screen.getByRole("button", { name: "reopen" }));
		expect(await screen.findByLabelText(/New secret/)).toHaveValue("");
	});
});

describe("ConfirmDialog", () => {
	it("clears a typed reason after cancel", async () => {
		const props = {
			onOpenChange: () => {},
			title: "Disable destination",
			description: "Stops deliveries.",
			confirmLabel: "Disable",
			onConfirm: async () => {},
		};
		const { rerender } = render(<ConfirmDialog open {...props} />);
		await userEvent.type(screen.getByLabelText("Reason (optional)"), "old");
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		rerender(<ConfirmDialog open={false} {...props} />);
		rerender(<ConfirmDialog open {...props} />);
		expect(await screen.findByLabelText("Reason (optional)")).toHaveValue("");
	});
});

describe("DestinationFormDialog limits", () => {
	it("sends limits on create and leaves them out when empty", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({ data: [project()], next_cursor: null }),
			),
			http.post(apiUrl("/destinations"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json(
					{ destination: destination(), signing_secret: "whsec_x" },
					{ status: 201 },
				);
			}),
		);
		const user = userEvent.setup();
		wrap(
			<DestinationFormDialog
				open
				onOpenChange={() => {}}
				onCreated={() => {}}
			/>,
		);
		await user.click(screen.getByLabelText("Project"));
		await user.click(await screen.findByRole("option", { name: "Payments" }));
		await user.type(screen.getByLabelText("Name"), "Billing API");
		await user.type(
			screen.getByLabelText("URL"),
			"https://billing.example.com/hooks",
		);
		expect(screen.getByLabelText("Max in flight")).toHaveAttribute(
			"placeholder",
			"Unlimited",
		);
		await user.type(screen.getByLabelText("Max in flight"), "4");
		await user.click(screen.getByRole("button", { name: /create/i }));
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0]).toMatchObject({ max_in_flight: 4 });
		expect(bodies[0]).not.toHaveProperty("rate_limit_per_s");
	});

	it("sends null when a limit is cleared on edit", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.patch(apiUrl("/destinations/dst_1"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json(destination({ id: "dst_1" }));
			}),
		);
		const user = userEvent.setup();
		wrap(
			<DestinationFormDialog
				open
				onOpenChange={() => {}}
				destination={destination({ id: "dst_1", rate_limit_per_s: 10 })}
			/>,
		);
		await user.clear(screen.getByLabelText("Rate limit (per s)"));
		await user.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0]).toMatchObject({ rate_limit_per_s: null });
	});
});

describe("ReplayDialog validation and outcomes (spec §8.8)", () => {
	it("rejects a reason longer than 500 characters", async () => {
		const sent = vi.fn();
		server.use(
			http.post(apiUrl("/failures/replay"), async ({ request }) => {
				sent(await request.json());
				return HttpResponse.json({ replayed: [], skipped: [] });
			}),
		);
		wrap(
			<ReplayDialog
				open
				onOpenChange={() => {}}
				target={{ kind: "bulk", deliveryIds: ["dlv_1"] }}
			/>,
		);
		// Typed keystrokes (not a programmatic change event), so a maxLength
		// cap would silently truncate and no error could ever appear.
		await userEvent.type(screen.getByLabelText("Reason"), "x".repeat(501));
		expect(await screen.findByText(/1–500 characters/i)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Replay 1" }));
		expect(sent).not.toHaveBeenCalled();
	});

	it("invalidates all delivery views after a successful replay", async () => {
		server.use(
			http.post(apiUrl("/failures/replay"), () =>
				HttpResponse.json({
					replayed: [
						{ delivery_id: "dlv_1", new_delivery_id: "dlv_9", enqueued: true },
					],
					skipped: [],
				}),
			),
		);
		wrap(
			<ReplayDialog
				open
				onOpenChange={() => {}}
				target={{ kind: "bulk", deliveryIds: ["dlv_1"] }}
			/>,
		);
		await userEvent.type(screen.getByLabelText("Reason"), "backend fixed");
		await userEvent.click(screen.getByRole("button", { name: "Replay 1" }));
		await waitFor(() => expect(invalidateDeliveryViews).toHaveBeenCalled());
	});

	it("keeps the returned status for a bulk replay", async () => {
		server.use(
			http.post(apiUrl("/failures/replay"), () =>
				HttpResponse.json({
					replayed: [
						{
							delivery_id: "dlv_1",
							new_delivery_id: "dlv_9",
							status: "paused",
							enqueued: false,
						},
					],
					skipped: [],
				}),
			),
		);
		wrap(
			<ReplayDialog
				open
				onOpenChange={() => {}}
				target={{ kind: "bulk", deliveryIds: ["dlv_1"] }}
			/>,
		);
		await userEvent.type(screen.getByLabelText("Reason"), "backend fixed");
		await userEvent.click(screen.getByRole("button", { name: "Replay 1" }));
		expect(await screen.findByText("dlv_9")).toBeInTheDocument();
		expect(screen.getByText("Paused")).toBeInTheDocument();
		expect(screen.getByText(/destination is paused/i)).toBeInTheDocument();
		expect(screen.queryByText(/delivered/i)).not.toBeInTheDocument();
	});

	it("issues one POST for a duplicate submit while pending", async () => {
		const sent = vi.fn();
		server.use(
			http.post(apiUrl("/failures/replay"), async ({ request }) => {
				sent(await request.json());
				await new Promise((r) => setTimeout(r, 100));
				return HttpResponse.json({ replayed: [], skipped: [] });
			}),
		);
		wrap(
			<ReplayDialog
				open
				onOpenChange={() => {}}
				target={{ kind: "bulk", deliveryIds: ["dlv_1"] }}
			/>,
		);
		await userEvent.type(screen.getByLabelText("Reason"), "backend fixed");
		const submit = screen.getByRole("button", { name: "Replay 1" });
		await userEvent.click(submit);
		await userEvent.click(submit);
		expect(
			await screen.findByText(/no new deliveries were created/i),
		).toBeInTheDocument();
		expect(sent).toHaveBeenCalledTimes(1);
	});

	it("keeps the returned status for a single-event replay", async () => {
		server.use(
			http.post(apiUrl("/events/evt_1/replay"), () =>
				HttpResponse.json({
					delivery_id: "dlv_9",
					status: "paused",
					enqueued: false,
				}),
			),
		);
		wrapWithRouter(
			<ReplayDialog
				open
				onOpenChange={() => {}}
				target={{ kind: "event", eventId: "evt_1" }}
			/>,
		);
		await userEvent.type(
			await screen.findByLabelText("Reason"),
			"backend fixed",
		);
		await userEvent.click(screen.getByRole("button", { name: "Replay 1" }));
		expect(await screen.findByText("dlv_9")).toBeInTheDocument();
		expect(screen.getByText("Paused")).toBeInTheDocument();
		expect(screen.getByText(/destination is paused/i)).toBeInTheDocument();
		expect(screen.queryByText(/delivered/i)).not.toBeInTheDocument();
	});

	it("reports the submitted IDs when the target changes mid-flight", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		server.use(
			http.post(apiUrl("/failures/replay"), async () => {
				await gate;
				return HttpResponse.json({
					replayed: [
						{ delivery_id: "dlv_1", new_delivery_id: "dlv_9", enqueued: true },
					],
					skipped: [],
				});
			}),
		);
		const qc = createQueryClient();
		const { rerender } = render(
			<QueryClientProvider client={qc}>
				<ReplayDialog
					open
					onOpenChange={() => {}}
					target={{ kind: "bulk", deliveryIds: ["dlv_1"] }}
				/>
			</QueryClientProvider>,
		);
		await userEvent.type(screen.getByLabelText("Reason"), "backend fixed");
		await userEvent.click(screen.getByRole("button", { name: "Replay 1" }));
		rerender(
			<QueryClientProvider client={qc}>
				<ReplayDialog
					open
					onOpenChange={() => {}}
					target={{ kind: "bulk", deliveryIds: ["dlv_2"] }}
				/>
			</QueryClientProvider>,
		);
		release();
		expect(await screen.findByText("dlv_9")).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Replay delivery" }),
		).toBeInTheDocument();
		expect(screen.queryByText("dlv_2")).not.toBeInTheDocument();
	});
});
