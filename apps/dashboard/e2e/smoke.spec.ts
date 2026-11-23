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
	const createAdmin = page.getByRole("button", {
		name: "Create admin account",
	});
	await passTurnstile(page, createAdmin);
	await createAdmin.click();
	await expect(page).toHaveURL(/\/projects$/);
	const blocked = await page.request.get("/api/admin/v1/overview");
	expect(blocked.status()).toBe(409);
	expect(await blocked.json()).toEqual({ error: "project_required" });
	await page.goto("/events");
	await expect(page).toHaveURL(/\/projects$/);

	const run = `e2e-${Date.now().toString(36)}`;
	const projectName = `E2E ${run}`;

	// Exit criterion 2: project → destination → source, UI only.
	await page
		.locator("header", { has: page.getByRole("heading", { name: "Projects" }) })
		.getByRole("button", { name: "New project" })
		.click();
	await page.getByLabel("Name").fill(projectName);
	const projectCreated = page.waitForResponse(
		(r) =>
			new URL(r.url()).pathname === "/api/admin/v1/projects" &&
			r.request().method() === "POST" &&
			r.status() === 201,
	);
	await page.getByRole("button", { name: "Create" }).click();
	const project = await (await projectCreated).json();
	await expect(page.getByRole("link", { name: projectName })).toHaveAttribute(
		"href",
		`/projects/${project.id}`,
	);
	await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();

	await page.goto("/endpoints?tab=destinations");
	const picker = page.getByRole("combobox", { name: "Active project" });
	await expect(picker).toHaveText(projectName);
	// Header and empty-state buttons both open the same dialog.
	await page.getByRole("button", { name: "New destination" }).first().click();
	await page.getByLabel("Name").fill(`Dest ${run}`);
	await page.getByLabel("URL").fill("https://example.com/hooks");
	await page.getByRole("button", { name: "Create" }).click();
	const destSecret = page.getByText(/^whsec_/);
	await expect(destSecret).toBeVisible();
	await page.getByLabel("I have stored this secret").check();
	await page.getByRole("button", { name: "Done" }).click();

	await page.goto("/endpoints?tab=sources");
	await page.getByRole("button", { name: "New source" }).first().click();
	await page
		.getByRole("combobox", { name: "Destination", exact: true })
		.click();
	await page.getByRole("option", { name: `Dest ${run}` }).click();
	await page.getByLabel("Name").fill(`Src ${run}`);
	await page.getByRole("button", { name: "Create" }).click();
	const row = page.getByRole("row", { name: new RegExp(`Src ${run}`) });
	await expect(row.getByText(/\/in\/src_/)).toBeVisible();

	// Collect the IDs the UI created, via the same admin API the UI uses.
	const api = (path: string) =>
		page.request.get(`/api/admin/v1${path}`).then((r) => r.json());
	const dest = (await api(`/destinations?project_id=${project.id}`)).data[0];
	const src = (await api(`/sources?project_id=${project.id}`)).data[0];

	// Seed a second pipeline through the real API and verify the list boundary.
	const origin = new URL(page.url()).origin;
	const create = async (path: string, data: Record<string, unknown>) => {
		const res = await page.request.post(`/api/admin/v1${path}`, {
			headers: { Origin: origin },
			data,
		});
		expect(res.status()).toBe(201);
		return res.json();
	};
	const other = await create("/projects", { name: `Other ${run}` });
	const otherDest = await create("/destinations", {
		project_id: other.id,
		name: `Other destination ${run}`,
		url: "https://example.com/other",
	});
	await create("/sources", {
		project_id: other.id,
		destination_id: otherDest.id,
		name: `Other source ${run}`,
		auth_type: "none",
		auth_config: {},
	});
	await page.reload();
	await picker.click();
	await page.getByRole("option", { name: `Other ${run}`, exact: true }).click();
	await expect(
		page.getByRole("link", { name: `Other source ${run}`, exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: `Src ${run}`, exact: true }),
	).toHaveCount(0);
	await page.getByRole("tab", { name: "Destinations" }).click();
	await expect(
		page.getByRole("link", { name: `Other destination ${run}`, exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: `Dest ${run}`, exact: true }),
	).toHaveCount(0);
	await picker.click();
	await page.getByRole("option", { name: projectName, exact: true }).click();
	await expect(
		page.getByRole("link", { name: `Dest ${run}`, exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: `Other destination ${run}`, exact: true }),
	).toHaveCount(0);

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
	await expect(page).toHaveURL(
		new RegExp(`/events/${eventId}\\?project_id=${project.id}$`),
	);
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
	await page.getByRole("button", { name: /^Account:/ }).click();
	await page.getByRole("menuitem", { name: "Log out" }).click();
	await page
		.getByRole("dialog", { name: "Log out?" })
		.getByRole("button", { name: "Log out" })
		.click();
	await expect(page).toHaveURL(/\/login/);
	await page.getByLabel("Username", { exact: true }).fill("e2e-admin");
	await page.getByLabel("Password", { exact: true }).fill("e2e-password-1234");
	const signIn = page.getByRole("button", { name: "Sign in" });
	await passTurnstile(page, signIn);
	await signIn.click();
	await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});
