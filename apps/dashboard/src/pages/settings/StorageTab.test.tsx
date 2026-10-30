import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";
import { apiUrl, DEFAULT_SETTINGS, server } from "@/test/server";

const SUMMARY = {
	enabled: true,
	last_verified: {
		id: "backup-2026-10-15-manual-abc",
		started_at: 1_760_000_000_000,
		finished_at: 1_760_000_060_000,
		bytes: 1234,
		rows: 56,
	},
	last_failed: null,
	running: null,
};

function useSummary(summary: Record<string, unknown> = SUMMARY) {
	server.use(
		http.get(apiUrl("/backups/summary"), () => HttpResponse.json(summary)),
	);
}

describe("Settings › Storage", () => {
	it("asks for confirmation with the extra eligible count when lowering retention", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.get(apiUrl("/archives/preview"), () =>
				HttpResponse.json({ eligible: 5000, currently_eligible: 1200 }),
			),
			http.patch(apiUrl("/settings"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json({});
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=storage");
		const hot = await screen.findByLabelText("Hot retention (days)");
		await user.clear(hot);
		await user.type(hot, "7");
		await user.click(screen.getByRole("button", { name: "Save storage" }));
		expect(await screen.findByText(/3,800 more events/)).toBeInTheDocument();
		expect(bodies).toHaveLength(0);
		await user.click(screen.getByRole("button", { name: "Save anyway" }));
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0]).toMatchObject({ storage: { hot_retention_days: 7 } });
	});

	it("starts a run now", async () => {
		let started = false;
		useSummary();
		server.use(
			http.post(apiUrl("/archives/run"), () => {
				started = true;
				return HttpResponse.json(
					{ instance_id: "archive-manual-x" },
					{ status: 202 },
				);
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=storage");
		await user.click(await screen.findByRole("button", { name: "Run now" }));
		expect(await screen.findByText(/archive-manual-x/)).toBeInTheDocument();
		expect(started).toBe(true);
	});

	it("shows the amber warning exactly when daily backups are off", async () => {
		useSummary({ ...SUMMARY, enabled: false });
		server.use(
			http.get(apiUrl("/settings"), () =>
				HttpResponse.json({
					...DEFAULT_SETTINGS,
					storage: {
						...DEFAULT_SETTINGS.storage,
						backup_enabled: false,
					},
				}),
			),
		);
		renderApp("/settings?tab=storage");
		expect(
			await screen.findByText(
				"Daily backups are off. Only D1 Time Travel (30 days) can restore this database.",
			),
		).toBeInTheDocument();
	});

	it("clicking Run backup now calls POST /backups/run", async () => {
		useSummary();
		let called = false;
		server.use(
			http.post(apiUrl("/backups/run"), () => {
				called = true;
				return HttpResponse.json(
					{
						backup_id: "backup-2026-10-16-manual-xyz",
						instance_id: "backup-2026-10-16-manual-xyz",
					},
					{ status: 202 },
				);
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=storage");
		await user.click(
			await screen.findByRole("button", { name: "Run backup now" }),
		);
		expect(
			await screen.findByText(/backup-2026-10-16-manual-xyz/),
		).toBeInTheDocument();
		expect(called).toBe(true);
	});

	it("a 409 shows that a backup is already running", async () => {
		useSummary();
		server.use(
			http.post(apiUrl("/backups/run"), () =>
				HttpResponse.json({ error: "backup_running" }, { status: 409 }),
			),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=storage");
		await user.click(
			await screen.findByRole("button", { name: "Run backup now" }),
		);
		expect(
			await screen.findByText("A backup is already running"),
		).toBeInTheDocument();
	});

	it("disables Run backup now while one is running", async () => {
		useSummary({
			...SUMMARY,
			running: {
				id: "backup-2026-10-16-manual-live",
				instance_id: "backup-2026-10-16-manual-live",
				started_at: 1_760_000_000_000,
			},
		});
		renderApp("/settings?tab=storage");
		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: "Run backup now" }),
			).toBeDisabled();
		});
	});

	it("shows a preview 503 inline and never PATCHes", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.get(apiUrl("/archives/preview"), () =>
				HttpResponse.json({ error: "preview_unavailable" }, { status: 503 }),
			),
			http.patch(apiUrl("/settings"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json({});
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=storage");
		const hot = await screen.findByLabelText("Hot retention (days)");
		await user.clear(hot);
		await user.type(hot, "7");
		await user.click(screen.getByRole("button", { name: "Save storage" }));
		expect(
			await screen.findByText(/could not load the archive preview/i),
		).toBeInTheDocument();
		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		expect(bodies).toHaveLength(0);
	});

	it("invalidates the stale confirmation after further edits", async () => {
		server.use(
			http.get(apiUrl("/archives/preview"), () =>
				HttpResponse.json({ eligible: 5000, currently_eligible: 1200 }),
			),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=storage");
		const hot = await screen.findByLabelText("Hot retention (days)");
		await user.clear(hot);
		await user.type(hot, "7");
		await user.click(screen.getByRole("button", { name: "Save storage" }));
		expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
		await user.type(hot, "1");
		await waitFor(() =>
			expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
		);
	});

	it("requires an explicit delete-without-files confirmation to switch archival off", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.patch(apiUrl("/settings"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json({});
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=storage");
		await screen.findByLabelText("Hot retention (days)");
		await user.click(screen.getByLabelText(/Archive to R2 before deleting/));
		await user.click(screen.getByRole("button", { name: "Save storage" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(/without archive files/i);
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(bodies).toHaveLength(0);
		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
	});

	it("summarizes both consequences when lowering retention and switching archival off", async () => {
		const bodies: unknown[] = [];
		server.use(
			http.get(apiUrl("/archives/preview"), () =>
				HttpResponse.json({ eligible: 5000, currently_eligible: 1200 }),
			),
			http.patch(apiUrl("/settings"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json({});
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=storage");
		const hot = await screen.findByLabelText("Hot retention (days)");
		await user.clear(hot);
		await user.type(hot, "7");
		await user.click(screen.getByLabelText(/Archive to R2 before deleting/));
		await user.click(screen.getByRole("button", { name: "Save storage" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(/more events/);
		expect(dialog).toHaveTextContent(/without archive files/);
		await user.click(screen.getByRole("button", { name: "Save anyway" }));
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0]).toMatchObject({
			storage: { hot_retention_days: 7, archive_enabled: false },
		});
	});

	it("says backups are disabled instead of never verified", async () => {
		useSummary({
			...SUMMARY,
			enabled: false,
			last_verified: null,
			last_failed: null,
			running: null,
		});
		renderApp("/settings?tab=storage");
		expect(await screen.findByText(/backups are disabled/i)).toBeInTheDocument();
		expect(screen.queryByText("No verified backup yet.")).not.toBeInTheDocument();
	});

	it("distinguishes never verified from disabled", async () => {
		useSummary({
			...SUMMARY,
			enabled: true,
			last_verified: null,
			last_failed: null,
			running: null,
		});
		renderApp("/settings?tab=storage");
		expect(
			await screen.findByText("No verified backup yet."),
		).toBeInTheDocument();
	});

	it("links the restore runbook without a restore action", async () => {
		useSummary();
		renderApp("/settings?tab=storage");
		const link = await screen.findByRole("link", {
			name: /backup and restore runbook/i,
		});
		expect(link).toHaveAttribute(
			"href",
			"https://github.com/huongda-group/hookflare/blob/main/docs/runbook.md#backup-and-restore",
		);
		expect(
			screen.queryByRole("button", { name: /restore/i }),
		).not.toBeInTheDocument();
	});

	it("preserves typed edits across a background settings refetch", async () => {
		useSummary();
		const { queryClient } = renderApp("/settings?tab=storage");
		const user = userEvent.setup();
		const hot = await screen.findByLabelText("Hot retention (days)");
		await user.clear(hot);
		await user.type(hot, "7");
		await queryClient.refetchQueries({ queryKey: ["settings"] });
		expect(await screen.findByLabelText("Hot retention (days)")).toHaveValue(7);
	});
});
