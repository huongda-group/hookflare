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
import type { AlertChannel } from "@hookflare/shared";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/router";
import { destination, project } from "@/test/fixtures";
import { apiUrl, server } from "@/test/server";
import { invalidateDeliveryViews } from "@/lib/queries/invalidate-delivery-views";
import { AlertChannelDialog } from "./AlertChannelDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { DestinationFormDialog } from "./DestinationFormDialog";
import { ReplayDialog } from "./ReplayDialog";
import { RotateSecretDialog } from "./RotateSecretDialog";
import { SecretRevealDialog } from "./SecretRevealDialog";
import { TestDeliveryDialog } from "./TestDeliveryDialog";

vi.mock("@/lib/queries/invalidate-delivery-views", () => ({
	invalidateDeliveryViews: vi.fn(),
}));

const wrap = async (ui: ReactNode) => {
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
	await router.load();
	return {
		user: userEvent.setup(),
		...render(<RouterProvider router={router} />),
	};
};

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
		await wrap(
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
		await wrap(
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
		await wrap(<Harness />);
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
		await wrap(
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
		await wrap(
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
		const { rerender } = await wrap(
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
		await wrap(<Harness />);
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
		await wrap(
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
		const { user } = await wrap(
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

	it("treats a blank policy override as inherit and shows the default", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.patch(apiUrl("/destinations/dst_1"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json(destination({ id: "dst_1" }));
			}),
		);
		const { user } = await wrap(
			<DestinationFormDialog
				open
				onOpenChange={() => {}}
				destination={destination({ id: "dst_1", max_attempts: 5 })}
			/>,
		);
		expect(
			await screen.findByPlaceholderText("default: 10000"),
		).toBeInTheDocument();
		await user.clear(screen.getByLabelText("Max attempts"));
		await user.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0]).toMatchObject({ max_attempts: null });
		expect(bodies[0]).not.toMatchObject({ max_attempts: 0 });
	});

	it("never coerces an explicit zero into inherit", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.patch(apiUrl("/destinations/dst_1"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json(destination({ id: "dst_1" }));
			}),
		);
		const { user } = await wrap(
			<DestinationFormDialog
				open
				onOpenChange={() => {}}
				destination={destination({ id: "dst_1" })}
			/>,
		);
		await screen.findByPlaceholderText("default: 10000");
		await user.type(screen.getByLabelText("Max attempts"), "0");
		await user.click(screen.getByRole("button", { name: /save/i }));
		// The shared contract rejects 0, but the rejection lands on the field —
		// the zero was never coerced to inherit (null) or sent at all.
		expect(
			await screen.findByText("Too small: expected number to be >=1"),
		).toBeInTheDocument();
		expect(bodies).toHaveLength(0);
		expect(screen.getByLabelText("Max attempts")).toHaveValue(0);
		expect(
			screen.getByRole("button", { name: /save/i }),
		).toBeInTheDocument();
	});

	it("never leaks the project into the patch body", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.patch(apiUrl("/destinations/dst_1"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json(destination({ id: "dst_1" }));
			}),
		);
		const { user } = await wrap(
			<DestinationFormDialog
				open
				onOpenChange={() => {}}
				destination={destination({ id: "dst_1" })}
			/>,
		);
		expect(
			screen.queryByRole("combobox", { name: "Project" }),
		).not.toBeInTheDocument();
		await user.type(screen.getByLabelText("Name"), " v2");
		await user.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0]).not.toHaveProperty("project_id");
	});

	it("reaches a project beyond the first option page", async () => {
		const first = Array.from({ length: 50 }, (_, i) =>
			project({ id: `prj_${i + 2}`, name: `Project ${i + 2}` }),
		);
		server.use(
			http.get(apiUrl("/projects"), ({ request }) => {
				const url = new URL(request.url);
				if (url.searchParams.get("cursor") === "c1") {
					return HttpResponse.json({
						data: [project({ id: "prj_far", name: "Faraway Project" })],
						next_cursor: null,
					});
				}
				return HttpResponse.json({ data: first, next_cursor: "c1" });
			}),
		);
		const { user } = await wrap(
			<DestinationFormDialog
				open
				onOpenChange={() => {}}
				onCreated={() => {}}
			/>,
		);
		await user.click(screen.getByRole("combobox", { name: "Project" }));
		expect(
			screen.queryByRole("option", { name: "Faraway Project" }),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Load more" }));
		await user.click(
			await screen.findByRole("option", { name: "Faraway Project" }),
		);
		expect(
			screen.getByRole("combobox", { name: "Project" }),
		).toHaveTextContent("Faraway Project");
	});

	it("keeps a server SSRF rejection inline on the URL field", async () => {
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({ data: [project()], next_cursor: null }),
			),
			http.post(apiUrl("/destinations"), () =>
				HttpResponse.json(
					{
						error: "url_private_blocked",
						issues: [
							{
								path: "url",
								code: "url_private_blocked",
								message: "URL resolves to a private address.",
							},
						],
					},
					{ status: 422 },
				),
			),
		);
		const { user } = await wrap(
			<DestinationFormDialog
				open
				onOpenChange={() => {}}
				onCreated={() => {}}
			/>,
		);
		await user.click(screen.getByRole("combobox", { name: "Project" }));
		await user.click(await screen.findByRole("option", { name: "Payments" }));
		await user.type(screen.getByLabelText("Name"), "Billing API");
		await user.type(
			screen.getByLabelText("URL"),
			"https://10.0.0.1/hooks",
		);
		await user.click(screen.getByRole("button", { name: /create/i }));
		expect(
			await screen.findByText("URL resolves to a private address."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /create/i }),
		).toBeInTheDocument();
	});

	it("blocks an accidental cancel and keeps the edits", async () => {
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({ data: [project()], next_cursor: null }),
			),
		);
		const { user } = await wrap(
			<DestinationFormDialog
				open
				onOpenChange={() => {}}
				onCreated={() => {}}
			/>,
		);
		await user.type(await screen.findByLabelText("Name"), "Billing");
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(
			await screen.findByRole("heading", { name: /discard/i }),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Keep editing" }));
		expect(screen.getByLabelText("Name")).toHaveValue("Billing");
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
		await wrap(
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
		await wrap(
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
		await wrap(
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
		await wrap(
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

describe("SecretRevealDialog unmount", () => {
	it("forgets the secret after close", async () => {
		const onClose = vi.fn();
		const { rerender } = render(
			<SecretRevealDialog
				secret="whsec_gone"
				label="Secret"
				onClose={onClose}
			/>,
		);
		expect(screen.getByText("whsec_gone")).toBeInTheDocument();
		rerender(
			<SecretRevealDialog secret={null} label="Secret" onClose={onClose} />,
		);
		expect(screen.queryByText("whsec_gone")).not.toBeInTheDocument();
	});
});

describe("RotateSecretDialog naming", () => {
	it("names the resource being rotated", async () => {
		await wrap(
			<RotateSecretDialog
				open
				onOpenChange={() => {}}
				resource="destination"
				id="dst_1"
				name="Billing API"
				onRotated={() => {}}
			/>,
		);
		expect(await screen.findByText(/billing api/i)).toBeInTheDocument();
	});
});

describe("AlertChannelDialog", () => {
	const channel: AlertChannel = {
		id: "ach_1",
		name: "ops",
		type: "discord",
		enabled: true,
		rules: [],
		project_ids: [],
		config_fingerprint: "a1b2c3d4",
		chat_id: null,
		created_at: 1,
		updated_at: 1,
	};

	it("creates with the webhook config through the current API", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.post(apiUrl("/alert-channels"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json(channel, { status: 201 });
			}),
		);
		const { user } = await wrap(
			<AlertChannelDialog onOpenChange={() => {}} onSaved={() => {}} />,
		);
		await user.type(screen.getByLabelText("Name"), "ops");
		await user.type(
			screen.getByLabelText("Webhook URL"),
			"https://discord.com/api/webhooks/123/abc",
		);
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0]).toMatchObject({
			name: "ops",
			config: {
				type: "discord",
				url: "https://discord.com/api/webhooks/123/abc",
			},
		});
	});

	it("edits metadata without re-sending untouched credentials", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.patch(apiUrl("/alert-channels/ach_1"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json(channel);
			}),
		);
		const { user } = await wrap(
			<AlertChannelDialog
				channel={channel}
				onOpenChange={() => {}}
				onSaved={() => {}}
			/>,
		);
		expect(await screen.findByLabelText(/New webhook URL/)).toHaveValue("");
		await user.clear(screen.getByLabelText("Name"));
		await user.type(screen.getByLabelText("Name"), "ops v2");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0]).toMatchObject({ name: "ops v2" });
		expect(bodies[0]).not.toHaveProperty("config");
	});

	it("only offers supported channel types", async () => {
		await wrap(
			<AlertChannelDialog onOpenChange={() => {}} onSaved={() => {}} />,
		);
		const options = Array.from(
			screen.getByLabelText("Type").querySelectorAll("option"),
		).map((o) => o.textContent);
		expect(options.sort()).toEqual(["discord", "slack", "telegram"]);
	});
});

describe("TestDeliveryDialog", () => {
	it("reports the synchronous test outcome without polling", async () => {
		let posts = 0;
		let polls = 0;
		server.use(
			http.post(apiUrl("/destinations/dst_1/test"), async () => {
				posts += 1;
				return HttpResponse.json({
					id: "tst_1",
					kind: "test",
					http_status: 204,
					error_kind: null,
					error_message: null,
					response_snippet: null,
					duration_ms: 87,
				});
			}),
			http.get(apiUrl("/destinations/dst_1/tests"), () => {
				polls += 1;
				return HttpResponse.json({ data: [], next_cursor: null });
			}),
		);
		const { user } = await wrap(
			<TestDeliveryDialog
				open
				onOpenChange={() => {}}
				destinationId="dst_1"
			/>,
		);
		await user.click(await screen.findByRole("button", { name: "Send" }));
		expect(await screen.findByText(/test delivery/i)).toBeInTheDocument();
		expect(screen.getByText(/HTTP 204/)).toBeInTheDocument();
		expect(posts).toBe(1);
		// One tests-list refresh from the invalidation is fine; polling is not.
		expect(polls).toBeLessThanOrEqual(1);
		await new Promise((r) => setTimeout(r, 100));
		expect(polls).toBeLessThanOrEqual(1);
	});
});
