import type { AlertChannel } from "@hookflare/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AlertChannelDialog } from "@/components/AlertChannelDialog";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DestinationFormDialog } from "@/components/DestinationFormDialog";
import { ProjectFormDialog } from "@/components/ProjectFormDialog";
import { ReplayDialog } from "@/components/ReplayDialog";
import { RotateSecretDialog } from "@/components/RotateSecretDialog";
import { SecretRevealDialog } from "@/components/SecretRevealDialog";
import { TestDeliveryDialog } from "@/components/TestDeliveryDialog";
import { invalidateDeliveryViews } from "@/lib/queries/invalidate-delivery-views";
import { createQueryClient } from "@/router";
import { destination, project } from "../helpers/fixtures";
import { createGate } from "../helpers/gate";
import { apiUrl, meFor, server } from "../helpers/server";

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
		qc,
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
				projectId="prj_1"
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
				projectId="prj_1"
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
	it("keeps the sent count after the caller clears its selection", async () => {
		server.use(
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
		// biome-ignore lint/correctness/noComponentHookFactories: the harness closes over this test's spies
		function Harness() {
			const [ids, setIds] = useState(["dlv_1", "dlv_2"]);
			return (
				<ReplayDialog
					projectId="prj_1"
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
				projectId="prj_1"
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
				projectId="prj_1"
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
				projectId="prj_1"
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
				<RotateSecretDialog projectId="prj_1" open={false} {...props} />
			</QueryClientProvider>,
		);
		rerender(
			<QueryClientProvider client={client}>
				<RotateSecretDialog projectId="prj_1" open {...props} />
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
		// biome-ignore lint/correctness/noComponentHookFactories: the harness closes over this test's spies
		function Harness() {
			const [open, setOpen] = useState(true);
			return (
				<>
					<button type="button" onClick={() => setOpen(true)}>
						reopen
					</button>
					<RotateSecretDialog
						projectId="prj_1"
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
				projectId="prj_1"
				open
				onOpenChange={() => {}}
				onCreated={() => {}}
			/>,
		);
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
				projectId="prj_1"
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
				projectId="prj_1"
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
				projectId="prj_1"
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
		expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
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
				projectId="prj_1"
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
				projectId="prj_1"
				open
				onOpenChange={() => {}}
				onCreated={() => {}}
			/>,
		);
		await user.type(screen.getByLabelText("Name"), "Billing API");
		await user.type(screen.getByLabelText("URL"), "https://10.0.0.1/hooks");
		await user.click(screen.getByRole("button", { name: /create/i }));
		expect(
			await screen.findByText("URL resolves to a private address."),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /create/i })).toBeInTheDocument();
	});

	it("blocks an accidental cancel and keeps the edits", async () => {
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({ data: [project()], next_cursor: null }),
			),
		);
		const { user } = await wrap(
			<DestinationFormDialog
				projectId="prj_1"
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
				projectId="prj_1"
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
				projectId="prj_1"
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
				projectId="prj_1"
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
		const gate = createGate();
		let posts = 0;
		server.use(
			http.post(apiUrl("/failures/replay"), async () => {
				posts += 1;
				await gate.wait();
				return HttpResponse.json({ replayed: [], skipped: [] });
			}),
		);
		const { user } = await wrap(
			<ReplayDialog
				projectId="prj_1"
				open
				onOpenChange={() => {}}
				target={{ kind: "bulk", deliveryIds: ["dlv_1"] }}
			/>,
		);
		await user.type(screen.getByLabelText("Reason"), "backend fixed");
		const submit = screen.getByRole("button", { name: "Replay 1" });
		await user.dblClick(submit);
		await waitFor(() => expect(submit).toBeDisabled());
		gate.release();
		expect(
			await screen.findByText(/no new deliveries were created/i),
		).toBeInTheDocument();
		expect(posts).toBe(1);
	});

	it("cannot be dismissed while the replay request is pending", async () => {
		const gate = createGate();
		let posts = 0;
		server.use(
			http.post(apiUrl("/failures/replay"), async () => {
				posts += 1;
				await gate.wait();
				return HttpResponse.json({ replayed: [], skipped: [] });
			}),
		);
		const onOpenChange = vi.fn();
		const { user } = await wrap(
			<ReplayDialog
				projectId="prj_1"
				open
				onOpenChange={onOpenChange}
				target={{ kind: "bulk", deliveryIds: ["dlv_1"] }}
			/>,
		);
		await user.type(screen.getByLabelText("Reason"), "backend fixed");
		await user.click(screen.getByRole("button", { name: "Replay 1" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Replay 1" })).toBeDisabled(),
		);
		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		await user.keyboard("{Escape}");
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalled();
		gate.release();
		expect(
			await screen.findByText(/no new deliveries were created/i),
		).toBeInTheDocument();
		expect(posts).toBe(1);
		// Once settled, the dialog closes normally again.
		await user.keyboard("{Escape}");
		expect(onOpenChange).toHaveBeenCalledWith(false);
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
				projectId="prj_1"
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
					projectId="prj_1"
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
					projectId="prj_1"
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
				projectId="prj_1"
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

	it("sends one create for a double-clicked Save", async () => {
		const gate = createGate();
		let posts = 0;
		server.use(
			http.post(apiUrl("/alert-channels"), async () => {
				posts += 1;
				await gate.wait();
				return HttpResponse.json(channel, { status: 201 });
			}),
		);
		const onSaved = vi.fn();
		const { user } = await wrap(
			<AlertChannelDialog onOpenChange={() => {}} onSaved={onSaved} />,
		);
		await user.type(screen.getByLabelText("Name"), "ops");
		await user.type(
			screen.getByLabelText("Webhook URL"),
			"https://discord.com/api/webhooks/123/abc",
		);
		const save = screen.getByRole("button", { name: "Save" });
		await user.dblClick(save);
		await waitFor(() => expect(save).toBeDisabled());
		gate.release();
		await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
		expect(save).toBeEnabled();
		expect(posts).toBe(1);
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
		const { qc, user } = await wrap(
			<TestDeliveryDialog
				projectId="prj_1"
				open
				onOpenChange={() => {}}
				destinationId="dst_1"
			/>,
		);
		await user.click(await screen.findByRole("button", { name: "Send" }));
		expect(await screen.findByText(/test delivery/i)).toBeInTheDocument();
		expect(screen.getByText(/HTTP 204/)).toBeInTheDocument();
		// Wait until every request has settled, then count: the dialog shows
		// the synchronous result and never polls the tests list.
		await waitFor(() => expect(qc.isFetching() + qc.isMutating()).toBe(0));
		expect(posts).toBe(1);
		expect(polls).toBe(0);
	});
});

describe("AlertChannelDialog telegram and rule scoping", () => {
	const telegram: AlertChannel = {
		id: "ach_2",
		name: "pager",
		type: "telegram",
		enabled: true,
		rules: [],
		project_ids: [],
		config_fingerprint: "ffee0011",
		chat_id: "-100123",
		created_at: 1,
		updated_at: 1,
	};

	it("creates a telegram channel scoped to the checked rules and projects", async () => {
		const bodies: unknown[] = [];
		const onSaved = vi.fn();
		server.use(
			http.post(apiUrl("/alert-channels"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json(telegram, { status: 201 });
			}),
		);
		const { user } = await wrap(
			<AlertChannelDialog onOpenChange={() => {}} onSaved={onSaved} />,
		);
		await user.selectOptions(screen.getByLabelText("Type"), "telegram");
		expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
		await user.type(screen.getByLabelText("Name"), "pager");
		await user.type(screen.getByLabelText("Bot token"), "123:abc");
		await user.type(screen.getByLabelText("Chat ID"), "-100123");
		// Checking then unchecking a rule leaves it out of the scope.
		await user.click(screen.getByLabelText("new_dead"));
		await user.click(screen.getByLabelText("new_dead"));
		await user.click(screen.getByLabelText("stuck_pending"));
		await user.click(await screen.findByLabelText("Payments"));
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(bodies[0]).toEqual({
			name: "pager",
			rules: ["stuck_pending"],
			project_ids: ["prj_1"],
			config: { type: "telegram", bot_token: "123:abc", chat_id: "-100123" },
		});
	});

	it("asks for the bot token again before changing a telegram chat ID", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.patch(apiUrl("/alert-channels/ach_2"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json(telegram);
			}),
		);
		const { user } = await wrap(
			<AlertChannelDialog
				channel={telegram}
				onOpenChange={() => {}}
				onSaved={() => {}}
			/>,
		);
		expect(screen.getByLabelText("Type")).toBeDisabled();
		expect(screen.getByLabelText("New bot token")).toHaveAttribute(
			"placeholder",
			"Leave empty to keep ffee0011",
		);
		await user.clear(screen.getByLabelText("Chat ID"));
		await user.type(screen.getByLabelText("Chat ID"), "-100999");
		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(
			await screen.findByText(
				"Enter the bot token again to change the chat ID",
			),
		).toBeInTheDocument();
		expect(bodies).toHaveLength(0);

		await user.type(screen.getByLabelText("New bot token"), "456:def");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0]).toMatchObject({
			config: { type: "telegram", bot_token: "456:def", chat_id: "-100999" },
		});
		expect(
			screen.queryByText("Enter the bot token again to change the chat ID"),
		).not.toBeInTheDocument();
	});

	it("saves untouched telegram metadata without credentials", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.patch(apiUrl("/alert-channels/ach_2"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json(telegram);
			}),
		);
		const { user } = await wrap(
			<AlertChannelDialog
				channel={telegram}
				onOpenChange={() => {}}
				onSaved={() => {}}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0]).not.toHaveProperty("config");
	});

	it.each([
		[
			"the first validation issue",
			HttpResponse.json(
				{
					error: "validation_failed",
					issues: [
						{ path: "config.url", message: "Use a Discord webhook URL" },
					],
				},
				{ status: 422 },
			),
			"Use a Discord webhook URL",
		],
		[
			"the error code when an issue has no message",
			HttpResponse.json(
				{ error: "invalid_channel", issues: [{ path: "config" }] },
				{ status: 422 },
			),
			"invalid_channel",
		],
		[
			"the status code when the body is not JSON",
			new HttpResponse("upstream", { status: 502 }),
			"http_502",
		],
		[
			"an unreadable success response",
			new HttpResponse("not json", {
				status: 201,
				headers: { "content-type": "application/json" },
			}),
			/SyntaxError/,
		],
	] as const)("shows %s", async (_label, response, message) => {
		const onSaved = vi.fn();
		server.use(http.post(apiUrl("/alert-channels"), () => response.clone()));
		const { user } = await wrap(
			<AlertChannelDialog onOpenChange={() => {}} onSaved={onSaved} />,
		);
		await user.type(screen.getByLabelText("Name"), "ops");
		await user.type(
			screen.getByLabelText("Webhook URL"),
			"https://discord.com/api/webhooks/1/a",
		);
		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText(message)).toBeInTheDocument();
		expect(onSaved).not.toHaveBeenCalled();
	});
});

/** Lets a test close and reopen the dialog like its page does. */
function TestDeliveryHarness({
	onOpenChange,
}: {
	onOpenChange: (o: boolean) => void;
}) {
	const [open, setOpen] = useState(true);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				reopen
			</button>
			<TestDeliveryDialog
				projectId="prj_1"
				open={open}
				onOpenChange={(o) => {
					onOpenChange(o);
					setOpen(o);
				}}
				destinationId="dst_1"
			/>
		</>
	);
}

describe("TestDeliveryDialog payload and outcomes", () => {
	it("offers only the default test event without config.write", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.get(apiUrl("/me"), () => HttpResponse.json(meFor("operator"))),
			http.post(apiUrl("/destinations/dst_1/test"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json({
					id: "tst_3",
					kind: "test",
					http_status: 204,
					error_kind: null,
					error_message: null,
					response_snippet: null,
					duration_ms: 5,
				});
			}),
		);
		const { qc, user } = await wrap(
			<TestDeliveryHarness onOpenChange={() => {}} />,
		);
		expect(
			await screen.findByText(
				"Sends the default test event, signed like a real delivery.",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByLabelText("JSON payload (optional)"),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Send" }));
		await screen.findByText(/HTTP 204/);
		await waitFor(() => expect(qc.isFetching() + qc.isMutating()).toBe(0));
		expect(bodies).toEqual([{}]);
	});

	it("rejects oversized and malformed payloads without sending", async () => {
		const sent = vi.fn();
		server.use(
			http.post(apiUrl("/destinations/dst_1/test"), () => {
				sent();
				return HttpResponse.json({});
			}),
		);
		const { user } = await wrap(
			<TestDeliveryHarness onOpenChange={() => {}} />,
		);
		const payload = await screen.findByLabelText("JSON payload (optional)");
		await user.click(payload);
		await user.paste("x".repeat(64 * 1024 + 1));
		await user.click(screen.getByRole("button", { name: "Send" }));
		expect(
			await screen.findByText("Payload is larger than 64 KB."),
		).toBeInTheDocument();
		await user.clear(payload);
		await user.paste("{not json");
		await user.click(screen.getByRole("button", { name: "Send" }));
		expect(
			await screen.findByText("Payload is not valid JSON."),
		).toBeInTheDocument();
		expect(sent).not.toHaveBeenCalled();
	});

	it("sends a custom payload and shows a failed outcome in full", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.post(apiUrl("/destinations/dst_1/test"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json({
					id: "tst_2",
					kind: "test",
					http_status: null,
					error_kind: "timeout",
					error_message: "No response within 10 s",
					response_snippet: "partial body",
					duration_ms: 10_000,
				});
			}),
		);
		const { user } = await wrap(
			<TestDeliveryHarness onOpenChange={() => {}} />,
		);
		await user.click(await screen.findByLabelText("JSON payload (optional)"));
		await user.paste('{"order": 42}');
		await user.click(screen.getByRole("button", { name: "Send" }));
		expect(await screen.findByText(/timeout · 10000 ms/)).toBeInTheDocument();
		expect(screen.getByText("No response within 10 s")).toBeInTheDocument();
		expect(screen.getByText("partial body")).toBeInTheDocument();
		expect(bodies).toEqual([{ payload: { order: 42 } }]);
	});

	it("shows a request error and forgets the outcome after close", async () => {
		const onOpenChange = vi.fn();
		server.use(
			http.post(apiUrl("/destinations/dst_1/test"), () =>
				HttpResponse.json({ error: "destination_disabled" }, { status: 409 }),
			),
		);
		const { user } = await wrap(
			<TestDeliveryHarness onOpenChange={onOpenChange} />,
		);
		await user.click(screen.getByRole("button", { name: "Send" }));
		expect(await screen.findByText("destination_disabled")).toBeInTheDocument();
		await user.keyboard("{Escape}");
		expect(onOpenChange).toHaveBeenLastCalledWith(false);
		await user.click(screen.getByRole("button", { name: "reopen" }));
		await screen.findByRole("dialog");
		expect(screen.queryByText("destination_disabled")).not.toBeInTheDocument();
		await user.click(screen.getByText("Close", { selector: "button" }));
		expect(onOpenChange).toHaveBeenLastCalledWith(false);
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});
});

/** Lets a test close and reopen the dialog like its page does. */
function ReplayHarness({
	onOpenChange,
}: {
	onOpenChange: (o: boolean) => void;
}) {
	const [open, setOpen] = useState(true);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				reopen
			</button>
			<ReplayDialog
				projectId="prj_1"
				open={open}
				onOpenChange={(o) => {
					onOpenChange(o);
					setOpen(o);
				}}
				target={{ kind: "bulk", deliveryIds: ["dlv_1", "dlv_2"] }}
			/>
		</>
	);
}

describe("ReplayDialog reason and close paths", () => {
	it("clears the missing-reason error as soon as one is typed", async () => {
		const { user } = await wrap(<ReplayHarness onOpenChange={() => {}} />);
		expect(
			screen.getByRole("heading", { name: "Replay 2 deliveries" }),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Replay 2" }));
		expect(
			await screen.findByText(/a reason is required/i),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Reason")).toHaveAttribute(
			"aria-invalid",
			"true",
		);
		await user.type(screen.getByLabelText("Reason"), "x");
		expect(screen.queryByText(/a reason is required/i)).not.toBeInTheDocument();
		expect(screen.getByLabelText("Reason")).toHaveAttribute(
			"aria-invalid",
			"false",
		);
	});

	it("shows a server error and closes on Cancel", async () => {
		const onOpenChange = vi.fn();
		server.use(
			http.post(apiUrl("/failures/replay"), () =>
				HttpResponse.json({ error: "too_many_deliveries" }, { status: 422 }),
			),
		);
		const { user } = await wrap(<ReplayHarness onOpenChange={onOpenChange} />);
		await user.type(screen.getByLabelText("Reason"), "retry");
		await user.click(screen.getByRole("button", { name: "Replay 2" }));
		expect(await screen.findByText("too_many_deliveries")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("lists skipped deliveries and starts fresh after Close", async () => {
		server.use(
			http.post(apiUrl("/failures/replay"), () =>
				HttpResponse.json({
					replayed: [],
					skipped: [{ delivery_id: "dlv_2", reason: "not_failed" }],
				}),
			),
		);
		const { user } = await wrap(<ReplayHarness onOpenChange={() => {}} />);
		await user.type(screen.getByLabelText("Reason"), "retry");
		await user.click(screen.getByRole("button", { name: "Replay 2" }));
		expect(await screen.findByText("dlv_2: not_failed")).toBeInTheDocument();
		await user.click(screen.getByText("Close", { selector: "button" }));
		await user.click(screen.getByRole("button", { name: "reopen" }));
		expect(await screen.findByLabelText("Reason")).toHaveValue("");
		expect(screen.queryByText("dlv_2: not_failed")).not.toBeInTheDocument();
	});
});

describe("SecretRevealDialog copy and outside clicks", () => {
	it("copies the secret to the clipboard", async () => {
		const user = userEvent.setup();
		render(
			<SecretRevealDialog
				secret="whsec_copy"
				label="Secret"
				onClose={() => {}}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Copy" }));
		expect(await navigator.clipboard.readText()).toBe("whsec_copy");
	});

	it("ignores outside clicks until the secret is stored", async () => {
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(
			<SecretRevealDialog
				secret="whsec_out"
				label="Secret"
				onClose={onClose}
			/>,
		);
		await screen.findByRole("dialog");
		// Radix registers the outside listener on the next tick and treats a
		// primary-button press as outside only once its click lands.
		const clickOutside = async () => {
			await new Promise((r) => setTimeout(r, 0));
			fireEvent.pointerDown(document.body);
			fireEvent.click(document.body);
			await new Promise((r) => setTimeout(r, 0));
		};
		await clickOutside();
		expect(onClose).not.toHaveBeenCalled();
		await user.click(screen.getByLabelText("I have stored this secret"));
		await clickOutside();
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
	});
});

describe("RotateSecretDialog reason and failures", () => {
	it("sends a trimmed reason and shows a rejection", async () => {
		const bodies: unknown[] = [];
		const onRotated = vi.fn();
		server.use(
			http.post(
				apiUrl("/destinations/dst_1/rotate-secret"),
				async ({ request }) => {
					bodies.push(await request.json());
					return HttpResponse.json(
						{ error: "rotation_pending" },
						{ status: 409 },
					);
				},
			),
		);
		const { user } = await wrap(
			<RotateSecretDialog
				projectId="prj_1"
				open
				onOpenChange={() => {}}
				resource="destination"
				id="dst_1"
				onRotated={onRotated}
			/>,
		);
		await user.type(screen.getByLabelText("Reason (optional)"), "  leaked  ");
		await user.click(screen.getByRole("button", { name: "Rotate" }));
		expect(await screen.findByText("rotation_pending")).toBeInTheDocument();
		expect(bodies).toEqual([{ grace_hours: 24, reason: "leaked" }]);
		expect(onRotated).not.toHaveBeenCalled();
	});

	it("closes on Cancel", async () => {
		const onOpenChange = vi.fn();
		const { user } = await wrap(
			<RotateSecretDialog
				projectId="prj_1"
				open
				onOpenChange={onOpenChange}
				resource="destination"
				id="dst_1"
				onRotated={() => {}}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});

describe("Escape on a clean form dialog", () => {
	it.each([
		[
			"destination",
			(onOpenChange: (o: boolean) => void) => (
				<DestinationFormDialog
					projectId="prj_1"
					open
					onOpenChange={onOpenChange}
				/>
			),
		],
		[
			"project",
			(onOpenChange: (o: boolean) => void) => (
				<ProjectFormDialog open onOpenChange={onOpenChange} />
			),
		],
	])("closes the %s form without a discard prompt", async (_name, ui) => {
		const onOpenChange = vi.fn();
		const { user } = await wrap(ui(onOpenChange));
		await screen.findByRole("dialog");
		await user.keyboard("{Escape}");
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(
			screen.queryByRole("heading", { name: /discard/i }),
		).not.toBeInTheDocument();
	});
});

describe("ProjectFormDialog create", () => {
	it("creates a project before the current user is loaded", async () => {
		const bodies: unknown[] = [];
		const onOpenChange = vi.fn();
		server.use(
			http.post(apiUrl("/projects"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json(project({ id: "prj_2", name: "Ops" }), {
					status: 201,
				});
			}),
		);
		const { user } = await wrap(
			<ProjectFormDialog open onOpenChange={onOpenChange} />,
		);
		await user.type(screen.getByLabelText("Name"), "Ops");
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(bodies).toEqual([{ name: "Ops" }]);
	});
});

describe("ChangePasswordDialog", () => {
	const renderDialog = (onOpenChange = vi.fn()) => {
		const user = userEvent.setup();
		render(
			<ChangePasswordDialog
				open
				onOpenChange={onOpenChange}
				onCloseAutoFocus={() => {}}
			/>,
		);
		return { user, onOpenChange };
	};
	const fill = async (user: ReturnType<typeof userEvent.setup>) => {
		await user.type(screen.getByLabelText("Current password"), "old-pass");
		await user.type(screen.getByLabelText("New password"), "new-pass");
		await user.type(screen.getByLabelText("Confirm new password"), "new-pass");
		await user.click(screen.getByRole("button", { name: "Save password" }));
	};

	it("shows a server failure other than a wrong password", async () => {
		server.use(
			http.post(apiUrl("/me/password"), () =>
				HttpResponse.json({ error: "rate_limited" }, { status: 429 }),
			),
		);
		const { user } = renderDialog();
		await fill(user);
		expect(await screen.findByText("rate_limited")).toBeInTheDocument();
	});

	it("confirms the change and closes", async () => {
		const { user, onOpenChange } = renderDialog();
		await fill(user);
		expect(
			await screen.findByRole("heading", { name: "Password changed" }),
		).toBeInTheDocument();
		await user.click(screen.getByText("Close", { selector: "button" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("closes on Cancel", async () => {
		const { user, onOpenChange } = renderDialog();
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
