import { expect, type Locator, type Page, test } from "@playwright/test";
import { seedDeadDelivery } from "./seed";

/**
 * The Turnstile widget (always-pass test keys) gates submit until it
 * yields a token. Click its checkbox once when it needs one; with the
 * test keys a single click passes.
 */
async function passTurnstile(page: Page, submit: Locator) {
	const box = page
		.frameLocator('iframe[src*="challenges.cloudflare.com"]')
		.getByRole("checkbox")
		.first();
	try {
		await box.waitFor({ state: "visible", timeout: 15_000 });
		if (await submit.isDisabled()) {
			await box.click({ timeout: 15_000 });
		}
	} catch (e) {
		// The widget already passed (or is absent with Turnstile off).
		// Log instead of swallowing: a widget that never renders (e.g. a
		// CSP regression) would otherwise surface only as a 30s timeout below.
		console.log("turnstile passthrough:", String(e));
	}
	await expect(submit).toBeEnabled({ timeout: 30_000 });
}

test("exit criteria: configure everything from the UI, then see the DLQ", async ({
	page,
}) => {
	// Fresh D1 per run, so onboarding is open: claim the first admin.
	await page.goto("/");
	await expect(page).toHaveURL(/\/setup$/);
	await page.getByLabel("Username", { exact: true }).fill("e2e-admin");
	await page.getByLabel("Password", { exact: true }).fill("e2e-password-1234");
	await page
		.getByLabel("Confirm password", { exact: true })
		.fill("e2e-password-1234");
	await page.getByLabel("Setup token", { exact: true }).fill("e2e-setup-token");
	const createAdmin = page.getByRole("button", {
		name: "Create admin account",
	});
	await passTurnstile(page, createAdmin);
	await createAdmin.click();
	await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

	const slug = `e2e-${Date.now().toString(36)}`;

	// Exit criterion 2: project → destination → source, UI only.
	await page.goto("/projects");
	await page
		.locator("header", { has: page.getByRole("heading", { name: "Projects" }) })
		.getByRole("button", { name: "New project" })
		.click();
	await page.getByLabel("Name").fill(`E2E ${slug}`);
	await page.getByLabel("Slug").fill(slug);
	await page.getByRole("button", { name: "Create" }).click();
	await expect(page.getByText(`E2E ${slug}`)).toBeVisible();

	await page.goto("/endpoints?tab=destinations");
	// Header and empty-state buttons both open the same dialog.
	await page.getByRole("button", { name: "New destination" }).first().click();
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
	await page.getByRole("button", { name: "New source" }).first().click();
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

	// M5c smoke: the new pages render their headings.
	await page.goto("/alerts");
	await expect(page.getByRole("heading", { name: "Alerts" })).toBeVisible();
	await page.goto("/archives");
	await expect(page.getByRole("heading", { name: "Archives" })).toBeVisible();
	await page.goto("/settings?tab=alerts");
	await expect(page.getByRole("heading", { name: "Channels" })).toBeVisible();
	await page.goto("/settings?tab=storage");
	await expect(
		page.getByRole("heading", { name: "Archive runs" }),
	).toBeVisible();

	// run_worker_first: an unknown API path is the Worker's JSON 404, not index.html.
	const nope = await page.request.get("/api/admin/v1/nope");
	expect(nope.status()).toBe(404);
	expect(nope.headers()["content-type"]).toContain("application/json");
	// And a client-side route deep link gets the SPA shell.
	const deep = await page.request.get("/events/evt_missing");
	expect(deep.headers()["content-type"]).toContain("text/html");

	// Log out and back in as the onboarded admin.
	await page.getByRole("button", { name: "Log out" }).click();
	await expect(page).toHaveURL(/\/login/);
	await page.getByLabel("Username", { exact: true }).fill("e2e-admin");
	await page.getByLabel("Password", { exact: true }).fill("e2e-password-1234");
	const signIn = page.getByRole("button", { name: "Sign in" });
	await passTurnstile(page, signIn);
	await signIn.click();
	await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});
