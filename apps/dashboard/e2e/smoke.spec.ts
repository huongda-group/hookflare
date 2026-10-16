import { expect, test } from "@playwright/test";
import { seedDeadDelivery } from "./seed";

test("exit criteria: configure everything from the UI, then see the DLQ", async ({
	page,
}) => {
	const slug = `e2e-${Date.now().toString(36)}`;

	// Exit criterion 2: project → destination → source, UI only.
	await page.goto("/projects");
	await page.getByRole("button", { name: "New project" }).click();
	await page.getByLabel("Name").fill(`E2E ${slug}`);
	await page.getByLabel("Slug").fill(slug);
	await page.getByRole("button", { name: "Create" }).click();
	await expect(page.getByText(`E2E ${slug}`)).toBeVisible();

	await page.goto("/endpoints?tab=destinations");
	await page.getByRole("button", { name: "New destination" }).click();
	await page.getByRole("combobox", { name: "Project", exact: true }).click();
	await page.getByRole("option", { name: `E2E ${slug}` }).click();
	await page.getByLabel("Name").fill(`Dest ${slug}`);
	await page.getByLabel("URL").fill("https://example.com/hooks");
	await page.getByRole("button", { name: "Create" }).click();
	const destSecret = page.getByText(/^whsec_/);
	await expect(destSecret).toBeVisible();
	await page.getByLabel("I have stored this secret").check();
	await page.getByRole("button", { name: "Done" }).click();

	await page.goto("/endpoints?tab=sources");
	await page.getByRole("button", { name: "New source" }).click();
	await page.getByRole("combobox", { name: "Project", exact: true }).click();
	await page.getByRole("option", { name: `E2E ${slug}` }).click();
	await page
		.getByRole("combobox", { name: "Destination", exact: true })
		.click();
	await page.getByRole("option", { name: `Dest ${slug}` }).click();
	await page.getByLabel("Name").fill(`Src ${slug}`);
	await page.getByRole("button", { name: "Create" }).click();
	const row = page.getByRole("row", { name: new RegExp(`Src ${slug}`) });
	await expect(row.getByText(/\/in\/src_/)).toBeVisible();

	// Collect the IDs the UI created, via the same admin API the UI uses.
	const api = (path: string) =>
		page.request.get(`/api/admin/v1${path}`).then((r) => r.json());
	const projects = await api("/projects?limit=200");
	const project = projects.data.find((p: { slug: string }) => p.slug === slug);
	const dest = (await api(`/destinations?project_id=${project.id}`)).data[0];
	const src = (await api(`/sources?project_id=${project.id}`)).data[0];

	// Exit criterion 1: a dead delivery appears under Failures › Dead Letter.
	const { deliveryId, eventId } = seedDeadDelivery({
		projectId: project.id,
		sourceId: src.id,
		destinationId: dest.id,
	});
	await page.goto(`/failures?project_id=${project.id}`);
	await expect(page.getByRole("tab", { name: "Dead Letter" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(
		page.getByRole("row", { name: new RegExp(deliveryId) }),
	).toBeVisible();
	await page.getByRole("link", { name: eventId }).click();
	await expect(page).toHaveURL(new RegExp(`/events/${eventId}$`));
	// Scoped to this delivery's timeline: "dead" also appears in badges elsewhere.
	const timeline = page.locator("section").filter({ hasText: deliveryId });
	await expect(timeline.locator('li[data-step="dead"]')).toBeVisible();

	// run_worker_first: an unknown API path is the Worker's JSON 404, not index.html.
	const nope = await page.request.get("/api/admin/v1/nope");
	expect(nope.status()).toBe(404);
	expect(nope.headers()["content-type"]).toContain("application/json");
	// And a client-side route deep link gets the SPA shell.
	const deep = await page.request.get("/events/evt_missing");
	expect(deep.headers()["content-type"]).toContain("text/html");
});
