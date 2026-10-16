import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

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
});
