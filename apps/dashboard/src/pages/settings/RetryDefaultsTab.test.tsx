import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/queries/keys";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

function patchSettings(sent: unknown[]) {
	server.use(
		http.patch(apiUrl("/settings"), async ({ request }) => {
			sent.push(await request.json());
			return HttpResponse.json({});
		}),
	);
}

describe("Settings › Retry defaults tab", () => {
	it("is read-only for viewers: disabled inputs, no save, no PATCH", async () => {
		const sent: unknown[] = [];
		patchSettings(sent);
		renderApp("/settings", { role: "viewer" });
		expect(await screen.findByLabelText("Max attempts")).toBeDisabled();
		expect(
			screen.queryByRole("button", { name: "Save" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Revert" }),
		).not.toBeInTheDocument();
		expect(sent).toHaveLength(0);
	});

	it("rejects a blank numeric override inline and never sends NaN", async () => {
		const sent: unknown[] = [];
		patchSettings(sent);
		const { user } = renderApp("/settings");
		const max = await screen.findByLabelText("Max attempts");
		await user.clear(max);
		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(
			await screen.findByText(/expected number|received nan|invalid/i, {
				selector: "[data-field-error]",
			}),
		).toBeInTheDocument();
		expect(sent).toHaveLength(0);
	});

	it("reverts unsaved edits back to the server values", async () => {
		const { user } = renderApp("/settings");
		const max = await screen.findByLabelText("Max attempts");
		expect(max).toHaveValue(20);
		await user.clear(max);
		await user.type(max, "8");
		expect(max).toHaveValue(8);
		await user.click(screen.getByRole("button", { name: "Revert" }));
		expect(max).toHaveValue(20);
	});

	it("rejects a reason longer than 500 characters and never PATCHes", async () => {
		const sent: unknown[] = [];
		patchSettings(sent);
		const { user } = renderApp("/settings");
		await screen.findByLabelText("Max attempts");
		await user.type(screen.getByLabelText("Reason (optional)"), "x".repeat(501));
		expect(
			await screen.findByText(/500 characters or fewer/i),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(sent).toHaveLength(0);
	});

	it("guards dirty edits on navigation", async () => {
		const { user, router } = renderApp("/settings");
		const max = await screen.findByLabelText("Max attempts");
		await user.clear(max);
		await user.type(max, "8");
		await user.click(screen.getByRole("link", { name: "Projects" }));
		expect(
			await screen.findByRole("heading", {
				name: "Discard unsaved changes?",
			}),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		await waitFor(() => expect(router.state.location.pathname).toBe("/projects"));
	});

	it("preserves typed edits across a background settings refetch", async () => {
		const { user, queryClient } = renderApp("/settings");
		const max = await screen.findByLabelText("Max attempts");
		await user.clear(max);
		await user.type(max, "8");
		await queryClient.refetchQueries({ queryKey: qk.settings });
		expect(await screen.findByLabelText("Max attempts")).toHaveValue(8);
	});
});
