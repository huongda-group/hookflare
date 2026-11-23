import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createGate } from "../../helpers/gate";
import { renderApp } from "../../helpers/render";
import { apiUrl, DEFAULT_SETTINGS, server } from "../../helpers/server";

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
		expect(
			await screen.findByText(/backups are disabled/i),
		).toBeInTheDocument();
		expect(
			screen.queryByText("No verified backup yet."),
		).not.toBeInTheDocument();
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
	it("saves non-reducing changes directly, including an archive retention", async () => {
		const bodies: unknown[] = [];
		useSummary();
		server.use(
			http.patch(apiUrl("/settings"), async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json({});
			}),
		);
		const user = userEvent.setup();
		const { router } = renderApp("/settings?tab=storage");
		const audit = await screen.findByLabelText("Audit retention (days)");
		await user.clear(audit);
		await user.type(audit, "400");
		await user.type(
			screen.getByLabelText("Archive retention (days, empty = forever)"),
			"730",
		);
		await user.click(screen.getByRole("button", { name: "Save storage" }));
		expect(
			await screen.findByText("Saved. Applies to the next archive run."),
		).toBeInTheDocument();
		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		expect(bodies).toEqual([
			{
				storage: {
					...DEFAULT_SETTINGS.storage,
					audit_retention_days: 400,
					archive_retention_days: 730,
				},
			},
		]);

		await user.click(screen.getByRole("link", { name: "Projects" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/projects"),
		);
		expect(
			screen.queryByRole("heading", { name: "Discard unsaved changes?" }),
		).not.toBeInTheDocument();
	});

	it("shows a concurrent-write conflict inline", async () => {
		useSummary();
		server.use(
			http.patch(apiUrl("/settings"), () =>
				HttpResponse.json({ error: "conflict" }, { status: 409 }),
			),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=storage");
		const audit = await screen.findByLabelText("Audit retention (days)");
		await user.clear(audit);
		await user.type(audit, "999");
		await user.click(screen.getByRole("button", { name: "Save storage" }));
		expect(
			await screen.findByText("conflict", {
				selector: "[data-field-error]",
			}),
		).toBeInTheDocument();
		expect(screen.queryByText(/applies to the next archive run/i)).toBeNull();
	});

	it("names an unreadable preview response as unknown", async () => {
		useSummary();
		server.use(
			http.get(
				apiUrl("/archives/preview"),
				() =>
					new HttpResponse("not json", {
						headers: { "content-type": "application/json" },
					}),
			),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=storage");
		const hot = await screen.findByLabelText("Hot retention (days)");
		await user.clear(hot);
		await user.type(hot, "10");
		await user.click(screen.getByRole("button", { name: "Save storage" }));
		expect(
			await screen.findByText(
				/could not load the archive preview \(unknown\)/i,
			),
		).toBeInTheDocument();
	});

	it("reverts edits and toggles the backup warning from the checkbox", async () => {
		useSummary();
		const user = userEvent.setup();
		renderApp("/settings?tab=storage");
		const hot = await screen.findByLabelText("Hot retention (days)");
		await user.clear(hot);
		await user.type(hot, "99");
		await user.click(screen.getByRole("button", { name: "Revert" }));
		expect(hot).toHaveValue(30);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		await user.click(screen.getByLabelText("Daily backup"));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/daily backups are off/i,
		);
		await user.click(screen.getByLabelText("Daily backup"));
		await waitFor(() =>
			expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
		);
	});

	it("treats a missing backup flag as enabled", async () => {
		useSummary();
		const { backup_enabled: _omit, ...storage } = DEFAULT_SETTINGS.storage;
		server.use(
			http.get(apiUrl("/settings"), () =>
				HttpResponse.json({ ...DEFAULT_SETTINGS, storage }),
			),
		);
		renderApp("/settings?tab=storage");
		expect(await screen.findByLabelText("Daily backup")).toBeChecked();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("shows a generic backup start failure", async () => {
		useSummary();
		server.use(
			http.post(apiUrl("/backups/run"), () =>
				HttpResponse.json({ error: "workflow_unavailable" }, { status: 503 }),
			),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=storage");
		await user.click(
			await screen.findByRole("button", { name: "Run backup now" }),
		);
		expect(
			await screen.findByText("workflow_unavailable", { selector: "p" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Run backup now" }),
		).toBeEnabled();
	});

	it("shows a failure newer than the last verified backup, with its error", async () => {
		useSummary({
			...SUMMARY,
			last_failed: {
				id: "backup-failed-new",
				started_at: SUMMARY.last_verified.started_at + 1,
				error: "R2 write failed",
			},
		});
		renderApp("/settings?tab=storage");
		expect(
			await screen.findByText(/Last failure backup-failed-new/),
		).toHaveTextContent(/: R2 write failed\.$/);
	});

	it("hides a failure older than the last verified backup", async () => {
		useSummary({
			...SUMMARY,
			last_failed: {
				id: "backup-failed-old",
				started_at: SUMMARY.last_verified.started_at - 1,
				error: null,
			},
		});
		renderApp("/settings?tab=storage");
		expect(await screen.findByText(/Last verified backup/)).toBeInTheDocument();
		expect(screen.queryByText(/backup-failed-old/)).not.toBeInTheDocument();
	});

	it("shows a failure without an error when nothing was verified", async () => {
		useSummary({
			...SUMMARY,
			last_verified: null,
			last_failed: {
				id: "backup-failed-only",
				started_at: 1_760_000_000_000,
				error: null,
			},
		});
		renderApp("/settings?tab=storage");
		expect(
			await screen.findByText(/Last failure backup-failed-only/),
		).toHaveTextContent(/started .*\.$/);
		expect(screen.getByText("No verified backup yet.")).toBeInTheDocument();
	});

	it("describes the last archive run", async () => {
		useSummary();
		server.use(
			http.get(apiUrl("/settings"), () =>
				HttpResponse.json({
					...DEFAULT_SETTINGS,
					archive_last_run: {
						instance_id: "archive-2026-10-16",
						status: "complete",
						started_at: 1_760_000_000_000,
					},
				}),
			),
		);
		renderApp("/settings?tab=storage");
		expect(
			await screen.findByText(/Last run archive-2026-10-16 \(complete\)/),
		).toBeInTheDocument();
		expect(screen.queryByText("No run yet.")).not.toBeInTheDocument();
	});

	it("starts one archive run for a double-clicked Run now", async () => {
		const gate = createGate();
		let posts = 0;
		useSummary();
		server.use(
			http.post(apiUrl("/archives/run"), async () => {
				posts += 1;
				await gate.wait();
				return HttpResponse.json(
					{ instance_id: "archive-manual-x" },
					{ status: 202 },
				);
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=storage");
		const run = await screen.findByRole("button", { name: "Run now" });
		await user.dblClick(run);
		await waitFor(() => expect(run).toBeDisabled());
		gate.release();
		expect(await screen.findByText(/archive-manual-x/)).toBeInTheDocument();
		await waitFor(() => expect(run).toBeEnabled());
		expect(posts).toBe(1);
	});

	it("shows an archive Run now failure inline", async () => {
		useSummary();
		server.use(
			http.post(apiUrl("/archives/run"), () =>
				HttpResponse.json({ error: "archive_running" }, { status: 409 }),
			),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=storage");
		const run = await screen.findByRole("button", { name: "Run now" });
		await user.click(run);
		expect(await screen.findByText("archive_running")).toBeInTheDocument();
		expect(run).toBeEnabled();
		expect(screen.queryByText(/^Started /)).not.toBeInTheDocument();
	});

	it("saves once for a double-clicked Save anyway", async () => {
		const gate = createGate();
		let patches = 0;
		useSummary();
		server.use(
			http.get(apiUrl("/archives/preview"), () =>
				HttpResponse.json({ eligible: 5000, currently_eligible: 1200 }),
			),
			http.patch(apiUrl("/settings"), async () => {
				patches += 1;
				await gate.wait();
				return HttpResponse.json({});
			}),
		);
		const user = userEvent.setup();
		renderApp("/settings?tab=storage");
		const hot = await screen.findByLabelText("Hot retention (days)");
		await user.clear(hot);
		await user.type(hot, "7");
		await user.click(screen.getByRole("button", { name: "Save storage" }));
		const confirm = await screen.findByRole("button", { name: "Save anyway" });
		await user.dblClick(confirm);
		await waitFor(() => expect(confirm).toBeDisabled());
		gate.release();
		expect(
			await screen.findByText(/applies to the next archive run/i),
		).toBeInTheDocument();
		expect(patches).toBe(1);
	});
});
