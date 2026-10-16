import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/router";
import { apiUrl, server } from "@/test/server";
import { ReplayDialog } from "./ReplayDialog";
import { RotateSecretDialog } from "./RotateSecretDialog";
import { SecretRevealDialog } from "./SecretRevealDialog";

const wrap = (ui: ReactNode) =>
	render(
		<QueryClientProvider client={createQueryClient()}>
			{ui}
		</QueryClientProvider>,
	);

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
});
