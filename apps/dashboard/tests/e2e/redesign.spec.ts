import { expect, test } from "@playwright/test";
import {
	installApp,
	overviewPayload,
	pageOverflow,
	rows,
	stressDataset,
} from "./fixtures";

const WIDTHS = [1440, 1280, 768, 390, 320] as const;

for (const width of [390, 1440]) {
	test(`stacked form controls have an 8px label gap at ${width}px`, async ({
		page,
	}) => {
		await installApp(page, { role: "admin" });
		await page.setViewportSize({ width, height: 900 });
		for (const [url, names] of [
			["/events", ["Search", "HTTP status", "From", "To"]],
			[
				"/settings?tab=retry",
				["Timeout (ms)", "Max attempts", "Reason (optional)"],
			],
		] as const) {
			await page.goto(url);
			for (const name of names) {
				const input = page.getByLabel(name, { exact: true });
				await expect(input).toBeVisible();
				const gap = await input.evaluate(
					(control: HTMLInputElement | HTMLTextAreaElement) => {
						const label = control.labels?.[0];
						if (!label) throw new Error(`No label for ${control.id}`);
						return (
							control.getBoundingClientRect().top -
							label.getBoundingClientRect().bottom
						);
					},
				);
				expect.soft(gap, `${url}: ${name}`).toBeCloseTo(8);
			}
		}
	});
}

test("add-user controls wrap without overlap on mobile", async ({ page }) => {
	await installApp(page, { role: "admin" });
	await page.setViewportSize({ width: 390, height: 900 });
	await page.goto("/settings?tab=users");

	const controls = [
		page.getByLabel("Username", { exact: true }),
		page.getByLabel("Password", { exact: true }),
		page.getByRole("combobox", { name: "Role", exact: true }),
		page.getByRole("button", { name: "Add user", exact: true }),
	];
	const boxes: { x: number; y: number; width: number; height: number }[] = [];
	for (const control of controls) {
		await expect(control).toBeVisible();
		const box = await control.boundingBox();
		if (!box) throw new Error("Missing add-user control");
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		for (const previous of boxes) {
			const overlap =
				box.x < previous.x + previous.width &&
				box.x + box.width > previous.x &&
				box.y < previous.y + previous.height &&
				box.y + box.height > previous.y;
			expect(overlap).toBe(false);
		}
		boxes.push(box);
	}
});

test("navigation has no page-level overflow from 1440px down to 320px", async ({
	page,
}) => {
	await installApp(page, { role: "admin" });
	for (const width of WIDTHS) {
		await page.setViewportSize({ width, height: 900 });
		await page.goto("/");
		await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
		if (width >= 1024) {
			const nav = page.getByRole("navigation", { name: "Main" });
			for (const name of [
				"Monitor",
				"Configure",
				"Administer",
				"Overview",
				"Events",
				"Failures",
				"Projects",
				"Endpoints",
				"Archives",
				"Audit",
				"Settings",
			]) {
				await expect(nav.getByText(name, { exact: true })).toBeVisible();
			}
		} else {
			await expect(
				page.getByRole("button", { name: "Open navigation" }),
			).toBeVisible();
			await page.getByRole("button", { name: "Open navigation" }).click();
			await expect(
				page.getByRole("dialog").getByRole("link", { name: "Events" }),
			).toBeVisible();
			await page.keyboard.press("Escape");
		}
		const overflow = await pageOverflow(page);
		expect(overflow, `page overflow at ${width}px`).toBe(0);
	}
});

test("the delivery path stays readable on desktop and out of the way on mobile", async ({
	page,
}) => {
	const app = await installApp(page, {
		authState: { setup_required: true, turnstile_site_key: null },
	});
	const intro = page.getByRole("region", { name: "About Hookflare" });
	const path = intro.getByRole("list", { name: "Delivery path" });
	const stepSpread = () =>
		path.evaluate((list) => {
			const first = list.firstElementChild?.getBoundingClientRect();
			const last = list.lastElementChild?.getBoundingClientRect();
			if (!first || !last) throw new Error("Missing delivery steps");
			const span = last.x + last.width / 2 - (first.x + first.width / 2);
			return span / list.getBoundingClientRect().width;
		});
	await page.setViewportSize({ width: 1024, height: 900 });
	await page.goto("/setup");
	await expect(
		intro.getByRole("heading", { name: "Trace every webhook delivery." }),
	).toBeVisible();
	await expect(path.getByRole("listitem")).toHaveText([
		/Event\s+received/i,
		/Delivery\s+tracked/i,
		/Attempt\s+recorded/i,
	]);
	const offsets = await path.getByRole("listitem").evaluateAll((steps) =>
		steps.map((step) => {
			const { x, width } = step.getBoundingClientRect();
			const icon = step.querySelector("svg")?.getBoundingClientRect();
			const label = step.querySelector("p")?.firstChild;
			if (!icon || !label) throw new Error("Missing delivery step content");
			const range = document.createRange();
			range.selectNodeContents(label);
			const text = range.getBoundingClientRect();
			const center = x + width / 2;
			return [
				icon.x + icon.width / 2 - center,
				text.x + text.width / 2 - center,
			];
		}),
	);
	for (const [icon, label] of offsets) {
		expect(Math.abs(icon)).toBeLessThan(1);
		expect(Math.abs(label)).toBeLessThan(1);
	}
	expect.soft(await stepSpread(), "setup step spread").toBeGreaterThan(0.64);
	expect(await pageOverflow(page)).toBe(0);

	app.update({
		authState: { setup_required: false, turnstile_site_key: null },
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/login");
	await expect(path).toBeVisible();
	expect.soft(await stepSpread(), "login step spread").toBeGreaterThan(0.64);
	await page.setViewportSize({ width: 390, height: 900 });
	await expect(intro).toBeHidden();
	await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
	expect(await pageOverflow(page)).toBe(0);
});

test("setup separates labels, inputs, and adjacent fields on mobile", async ({
	page,
}) => {
	await installApp(page, {
		authState: { setup_required: true, turnstile_site_key: null },
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/setup");
	for (const name of ["Username", "Password", "Confirm password"]) {
		const input = page.getByLabel(name, { exact: true });
		const spacing = await input.evaluate((element: HTMLInputElement) => {
			const label = element.labels?.[0];
			const help = document.getElementById(`${element.id}-help`);
			const { top, bottom } = element.getBoundingClientRect();
			return {
				label: label ? top - label.getBoundingClientRect().bottom : 0,
				help: help ? help.getBoundingClientRect().top - bottom : null,
			};
		});
		expect
			.soft(spacing.label, `${name} label-to-input gap`)
			.toBeGreaterThanOrEqual(8);
		if (spacing.help !== null) {
			expect
				.soft(spacing.help, `${name} input-to-help gap`)
				.toBeGreaterThanOrEqual(8);
		}
	}
	for (const [help, next] of [
		["setup-username-help", "setup-password"],
		["setup-password-help", "setup-confirm"],
	]) {
		const helpBox = await page.locator(`#${help}`).boundingBox();
		const labelBox = await page.locator(`label[for="${next}"]`).boundingBox();
		expect(
			labelBox && helpBox ? labelBox.y - helpBox.y - helpBox.height : 0,
		).toBeGreaterThanOrEqual(20);
	}
	expect(await pageOverflow(page)).toBe(0);
});

test("setup and login render explicit states and stay keyboard operable", async ({
	page,
}) => {
	const setup = await installApp(page, {
		role: "admin",
		authState: { setup_required: true, turnstile_site_key: null },
	});
	await page.goto("/");
	await expect(page).toHaveURL(/\/setup$/);
	await expect(
		page.getByRole("heading", { name: "Set up your instance" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Create admin account" }),
	).toBeVisible();
	await expect(
		page.getByText("Bot protection is off.", { exact: true }),
	).toBeVisible();
	const username = page.getByLabel("Username", { exact: true });
	const password = page.getByLabel("Password", { exact: true });
	const confirm = page.getByLabel("Confirm password", { exact: true });
	await username.fill("e2e-admin");
	await page.keyboard.press("Tab");
	await expect(password).toBeFocused();
	await password.fill("e2e-password-1234");
	await page.keyboard.press("Tab");
	await expect(confirm).toBeFocused({ timeout: 1500 });
	await page.keyboard.press("Shift+Tab");
	await expect(password).toBeFocused();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	await expect(
		page.getByRole("button", { name: "Show Password", exact: true }),
	).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(password).toHaveAttribute("type", "text");
	await expect(password).toHaveValue("e2e-password-1234");
	await page.keyboard.press("Tab");
	await expect(
		page.getByRole("button", { name: "Show Confirm password", exact: true }),
	).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(confirm).toHaveAttribute("type", "text");
	expect(await pageOverflow(page)).toBe(0);

	setup.update({
		authState: { setup_required: false, turnstile_site_key: null },
		login: { kind: "error", status: 401, code: "invalid_credentials" },
	});
	await page.goto("/login");
	await expect(
		page.getByRole("heading", { name: "Sign in to Hookflare" }),
	).toBeVisible();
	await page.getByLabel("Username", { exact: true }).fill("e2e-viewer");
	await page.getByLabel("Password", { exact: true }).fill("wrong-password-1");
	await page.getByRole("button", { name: "Sign in" }).click();
	await expect(page.getByText("Invalid username or password")).toBeVisible();
	await expect(page).toHaveURL(/\/login/);
	expect(await pageOverflow(page)).toBe(0);
});

test("setup password toggle hover stays inside the input border", async ({
	page,
}) => {
	await installApp(page, {
		authState: { setup_required: true, turnstile_site_key: null },
	});
	await page.goto("/setup");
	for (const name of ["Password", "Confirm password"]) {
		const input = page.getByLabel(name, { exact: true });
		const toggle = page.getByRole("button", {
			name: `Show ${name}`,
			exact: true,
		});
		const face = toggle.getByText("Show", { exact: true });
		await toggle.hover();
		const fieldBox = await input.boundingBox();
		const faceBox = await face.boundingBox();
		const hitBox = await toggle.boundingBox();
		if (!fieldBox || !faceBox || !hitBox)
			throw new Error("Missing password control");
		expect(hitBox.height).toBeGreaterThanOrEqual(44);
		expect(faceBox.y).toBeGreaterThan(fieldBox.y);
		expect(faceBox.y + faceBox.height).toBeLessThan(
			fieldBox.y + fieldBox.height,
		);
		expect(faceBox.x + faceBox.width).toBeLessThan(fieldBox.x + fieldBox.width);
	}
});

test("failures recovery is keyboard operable and never claims Delivered from a 201", async ({
	page,
}) => {
	const { requests } = await installApp(page, {
		role: "operator",
		bulkReplay: { kind: "ok", enqueued: false },
	});
	await page.goto("/failures?project_id=prj_1");
	await expect(page.getByRole("heading", { name: "Failures" })).toBeVisible();
	const box = page.getByRole("checkbox", { name: "Select dlv_1" });
	await box.scrollIntoViewIfNeeded();
	await box.focus();
	await page.keyboard.press("Space");
	await expect(box).toBeChecked();
	const replayButton = page.getByRole("button", {
		name: "Replay selected (1)",
	});
	await replayButton.focus();
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("heading", { name: "Replay delivery" }),
	).toBeVisible();
	await page.getByLabel("Reason").fill("Backend recovered");
	const submit = page.getByRole("button", { name: "Replay 1" });
	await submit.focus();
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("region", { name: "Awaiting enqueue" }),
	).toBeVisible();
	await expect(page.getByText("Awaiting enqueue (1)")).toBeVisible();
	await expect(page.getByText("Delivered")).not.toBeVisible();
	expect(
		requests.some(
			(r) => r.method === "POST" && r.path.startsWith("/failures/replay"),
		),
	).toBe(true);
	expect(await pageOverflow(page)).toBe(0);
});

test("destination pause confirms with a reason via keyboard", async ({
	page,
}) => {
	const { requests } = await installApp(page, { role: "operator" });
	await page.goto("/endpoints/destinations/dst_1");
	await expect(page.getByText("Billing API").first()).toBeVisible();
	const actions = page.getByRole("button", { name: "Actions" }).first();
	await actions.scrollIntoViewIfNeeded();
	await actions.focus();
	await page.keyboard.press("Enter");
	const pauseItem = page.getByRole("menuitem", { name: "Pause" });
	await pauseItem.focus();
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("heading", { name: "Pause Billing API?" }),
	).toBeVisible();
	await page.getByLabel("Reason (optional)").fill("Upstream deploy");
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	await expect(
		requests.some(
			(r) =>
				r.method === "POST" &&
				r.path === "/destinations/dst_1/pause?project_id=prj_1",
		),
	).toBe(true);
});

test("role matrix hides admin UI and viewer direct links fetch nothing protected", async ({
	page,
}) => {
	const fixture = await installApp(page, { role: "viewer" });
	await page.goto("/");
	const nav = page.getByRole("navigation", { name: "Main" });
	await expect(nav).toContainText("Overview");
	await expect(nav).not.toContainText("Audit");
	await expect(nav).toContainText("Archives");

	await page.goto("/audit");
	await expect(
		page.getByText("The audit log requires the admin role."),
	).toBeVisible();
	expect(fixture.requests.some((r) => r.path.startsWith("/audit"))).toBe(false);

	await page.goto("/settings");
	await expect(page.getByRole("tab", { name: "Retry defaults" })).toBeVisible();
	await expect(page.getByRole("tab", { name: "Users" })).not.toBeVisible();
	await expect(page.getByRole("tab", { name: "Storage" })).not.toBeVisible();
	await expect(page.getByRole("tab", { name: "Alerts" })).not.toBeVisible();
	expect(await pageOverflow(page)).toBe(0);
});

test("all Settings tabs align with the Projects content edges", async ({
	page,
}) => {
	await installApp(page, { role: "admin" });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/projects");
	const projects = page.getByRole("region", { name: "Results" });
	await expect(projects).toBeVisible();
	const projectsBox = await projects.boundingBox();
	if (!projectsBox) throw new Error("Missing Projects content bounds");

	await page.goto("/settings");
	for (const [tab, section] of [
		["Retry defaults", "Retry defaults"],
		["Storage", "Retention"],
		["Alerts", "Rules"],
		["Users", null],
	] as const) {
		await page.getByRole("tab", { name: tab, exact: true }).click();
		const panel = page.getByRole("tabpanel", { name: tab });
		const content = section
			? panel.locator("section").filter({
					has: page.getByRole("heading", { name: section, exact: true }),
				})
			: panel.getByRole("region", { name: "Results" });
		await expect(content).toBeVisible();
		const box = await content.boundingBox();
		if (!box) throw new Error(`Missing ${tab} content bounds`);
		expect.soft(box.x, `${tab} left edge`).toBeCloseTo(projectsBox.x, 0);
		expect
			.soft(box.x + box.width, `${tab} right edge`)
			.toBeCloseTo(projectsBox.x + projectsBox.width, 0);
	}
});

test("blocked role mutation shows feedback and a downgrade removes admin UI", async ({
	page,
}) => {
	const fixture = await installApp(page, {
		role: "admin",
		patchUser: { kind: "error", status: 403, code: "forbidden" },
	});
	await page.goto("/settings?tab=users");
	await expect(page.getByRole("button", { name: "Add user" })).toBeVisible();
	await page.getByRole("combobox", { name: "Role of op" }).click();
	await page.getByRole("option", { name: "admin" }).click();
	await page.getByRole("button", { name: "Change role" }).click();
	await expect(
		page.getByRole("heading", { name: "Change op to admin?" }),
	).toBeVisible();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Change role" })
		.click();
	await expect(page.getByText(/forbidden/)).toBeVisible();

	fixture.setRole("viewer");
	await page.goto("/settings?tab=users");
	await expect(page.getByRole("tab", { name: "Users" })).not.toBeVisible();
	await expect(page.getByRole("tab", { name: "Retry defaults" })).toBeVisible();
});

test("zoom approximation (640 CSS px viewport plus CSS zoom) keeps every screen within the viewport", async ({
	page,
}, testInfo) => {
	await installApp(page, { role: "admin" });
	await page.setViewportSize({ width: 640, height: 900 });
	for (const [name, url] of [
		["overview", "/"],
		["events", "/events"],
		["failures", "/failures"],
		["endpoints", "/endpoints"],
		["settings", "/settings"],
	] as const) {
		await page.goto(url);
		await page.waitForLoadState("networkidle");
		const overflow = await pageOverflow(page);
		expect(overflow, `${name} at 640 CSS px`).toBe(0);
		await testInfo.attach(`zoom200-${name}`, {
			body: await page.screenshot(),
			contentType: "image/png",
		});
	}
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto("/events");
	await page.evaluate(() => {
		document.body.style.zoom = "200%";
	});
	const zoomed = await pageOverflow(page);
	expect(zoomed, "events at 200% CSS zoom").toBe(0);
});

test("drawer and dialogs close on Escape and restore focus", async ({
	page,
}) => {
	await installApp(page, { role: "admin" });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	const trigger = page.getByRole("button", { name: "Open navigation" });
	await trigger.click();
	const drawer = page.getByRole("dialog", { name: "Navigation" });
	await expect(drawer).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(drawer).not.toBeVisible();
	await expect(trigger).toBeFocused();

	const skip = page.getByRole("link", { name: "Skip to content" });
	await skip.focus();
	await page.keyboard.press("Enter");
	expect(
		await page.evaluate(() => {
			const active = document.activeElement;
			return (
				active?.closest("#main-content") !== null ||
				active?.id === "main-content"
			);
		}),
	).toBe(true);

	await page.goto("/projects");
	const opener = page.getByRole("button", { name: "New project" });
	await opener.click();
	await expect(
		page.getByRole("heading", { name: "New project" }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("heading", { name: "New project" }),
	).not.toBeVisible();
	await expect(opener).toBeFocused();

	await opener.click();
	await expect(
		page.getByRole("heading", { name: "New project" }),
	).toBeVisible();
	await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
	await expect(
		page.getByRole("heading", { name: "New project" }),
	).not.toBeVisible();
	await expect(opener).toBeFocused();
	expect(await page.evaluate(() => document.hasFocus())).toBe(true);
});

test("payload needs an explicit action, stays bounded, and missing disables replay", async ({
	page,
}) => {
	const fixture = await installApp(page, { role: "operator" });
	await page.goto("/events/evt_1");
	await expect(page.getByRole("heading", { name: "evt_1" })).toBeVisible();
	await page.getByRole("tab", { name: "Payload" }).click();
	expect(fixture.payloadRequests()).toHaveLength(0);
	await page.getByRole("button", { name: "Show payload" }).click();
	await expect(page.getByRole("tabpanel")).toContainText("ok");
	expect(fixture.payloadRequests()).toHaveLength(1);
	expect(await pageOverflow(page)).toBe(0);

	fixture.update({ payload: { kind: "missing" } });
	await page.goto("/events/evt_1");
	await page.getByRole("tab", { name: "Payload" }).click();
	await page.getByRole("button", { name: "Show payload" }).click();
	await expect(page.getByText("Payload no longer available.")).toBeVisible();
	expect(fixture.payloadRequests()).toHaveLength(2);
	await expect(page.getByRole("button", { name: "Replay" })).toBeDisabled();
});

test("long ids, long urls, and duplicate names never break the viewport", async ({
	page,
}, testInfo) => {
	const stress = stressDataset();
	await installApp(page, {
		role: "admin",
		projects: {
			kind: "data",
			items: [rows.project(), rows.project({ id: "prj_duplicate" })],
		},
		events: { kind: "data", items: stress.events },
		eventDetail: stress.eventDetail as unknown as Record<string, unknown>,
		failures: { kind: "data", items: stress.failures },
		sources: { kind: "data", items: stress.sources },
		destinations: { kind: "data", items: stress.destinations },
	});
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 900 });
		await page.goto("/events");
		await expect(page.getByText(stress.longEventId).first()).toBeVisible();
		expect(await pageOverflow(page), `events at ${width}px`).toBe(0);

		await page.goto(`/events/${stress.longEventId}`);
		await expect(page.locator("h1").filter({ hasText: "evt_" })).toBeVisible();
		expect(await pageOverflow(page), `event detail at ${width}px`).toBe(0);

		await page.goto("/endpoints?tab=destinations");
		await expect(page.getByText(stress.longUrl).first()).toBeVisible();
		expect(await pageOverflow(page), `endpoints at ${width}px`).toBe(0);
		await testInfo.attach(`stress-${width}`, {
			body: await page.screenshot(),
			contentType: "image/png",
		});
	}

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto("/events");
	const picker = page.getByRole("combobox", { name: "Active project" });
	await picker.click();
	await expect(
		page.getByRole("listbox").getByRole("option", { name: /Payments/ }),
	).toHaveCount(2);
	await page.keyboard.press("Escape");
	expect(await pageOverflow(page)).toBe(0);
});

test("empty, error, and one-time-secret states behave and recover", async ({
	page,
}, testInfo) => {
	await installApp(page, {
		role: "admin",
		events: { kind: "empty" },
	});
	await page.goto("/events");
	await expect(page.getByText("No events match these filters.")).toBeVisible();
	await testInfo.attach("empty-events", {
		body: await page.screenshot(),
		contentType: "image/png",
	});

	const failed = await installApp(page, {
		role: "admin",
		overview: { error: "internal" },
	});
	await page.goto("/");
	await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
	await testInfo.attach("error-overview", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
	expect(failed.requests.some((r) => r.path.startsWith("/overview"))).toBe(
		true,
	);

	await installApp(page, { role: "admin" });
	await page.goto("/endpoints?tab=destinations");
	await page.getByRole("button", { name: "New destination" }).click();
	await page.getByLabel("Name").fill("Secret lifecycle");
	await page.getByLabel("URL").fill("https://example.com/secret-hooks");
	await page.getByRole("button", { name: "Create" }).click();
	const secret = page.getByText(/^whsec_/);
	await expect(secret).toBeVisible();
	await testInfo.attach("secret-reveal", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
	await page.getByLabel("I have stored this secret").check();
	await page.getByRole("button", { name: "Done" }).click();
	await expect(secret).not.toBeVisible();
});

test("named screens render their headings and landmarks", async ({
	page,
}, testInfo) => {
	await installApp(page, {
		role: "admin",
		alerts: { kind: "data", items: [rows.alert()] },
		archives: { kind: "data", items: [rows.archive()] },
	});
	const screens = [
		["login", "/login", "Sign in to Hookflare"],
		["overview", "/", "Overview"],
		["events", "/events", "Events"],
		["event-detail", "/events/evt_1", "evt_1"],
		["failures", "/failures", "Failures"],
		["endpoints", "/endpoints", "Endpoints"],
		["settings", "/settings", "Settings"],
		["alerts", "/alerts", "Alerts"],
		["archives", "/archives", "Archives"],
		["audit", "/audit", "Audit"],
	] as const;
	for (const [name, url, heading] of screens) {
		await page.goto(url);
		await expect(
			page.getByRole("heading", { name: heading }),
			`${name} heading`,
		).toBeVisible();
		expect(await pageOverflow(page), `${name} overflow`).toBe(0);
		await testInfo.attach(`screen-${name}`, {
			body: await page.screenshot(),
			contentType: "image/png",
		});
	}
	await installApp(page, {
		role: "admin",
		authState: { setup_required: true, turnstile_site_key: null },
	});
	await page.goto("/setup");
	await expect(
		page.getByRole("heading", { name: "Set up your instance" }),
	).toBeVisible();
	await testInfo.attach("screen-setup", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
});

test("attention precedes reporting and retains period-scoped investigation", async ({
	page,
}) => {
	const overview = overviewPayload();
	await installApp(page, { overview, role: "viewer" });
	await page.goto("/?project_id=prj_1");
	const attention = page.getByRole("heading", { name: "Needs attention" });
	const reporting = page.getByRole("heading", { name: "Delivery performance" });
	await expect(attention).toBeVisible();
	await expect(reporting).toBeVisible();
	expect(
		await attention.evaluate(
			(a, b) =>
				!!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING),
			await reporting.elementHandle(),
		),
	).toBe(true);
	await expect(page.getByRole("link", { name: "1 open alert" })).toBeVisible();
	await expect(page.getByText("Failures in selected period")).toBeVisible();
	await page.getByRole("link", { name: "Investigate Billing API" }).click();
	await expect.poll(() => new URL(page.url()).pathname).toBe("/failures");
	await expect
		.poll(() => Object.fromEntries(new URL(page.url()).searchParams))
		.toMatchObject({
			destination_id: "dst_1",
			project_id: "prj_1",
			from: String(overview.from),
			to: String(overview.to),
		});
});

test("attempt selection inspects its own delivery and never renders response HTML", async ({
	page,
}) => {
	const original = rows.eventDetail().deliveries[0];
	const replay = {
		...original,
		id: "dlv_replay",
		kind: "replay",
		created_by: "operator",
		created_at: original.created_at + 10_000,
		attempts: [
			{
				...original.attempts[0],
				id: "att_replay",
				response_snippet: "<script>replay response</script>",
			},
		],
	};
	await installApp(page, {
		eventDetail: rows.eventDetail({ deliveries: [original, replay] }),
	});
	await page.goto("/events/evt_1");
	const inspector = page.getByRole("region", {
		name: "Request & response inspector",
	});
	await expect(inspector).toContainText("replay response");
	await expect(inspector).toContainText("dlv_replay");
	await expect(inspector.locator("script")).toHaveCount(0);
	await page.getByRole("button", { name: "Expand delivery dlv_1" }).click();
	await page
		.getByRole("region", { name: "Delivery dlv_1" })
		.getByRole("button", { name: /Attempt #1/ })
		.click();
	await expect(inspector).toContainText("upstream down");
	await expect(inspector).toContainText("dlv_1");
	await expect(inspector).not.toContainText("replay response");
});

test("viewer cannot fetch payload or replay, operator reveal and replay Escape return focus", async ({
	page,
}) => {
	const fixture = await installApp(page, { role: "viewer" });
	await page.goto("/events/evt_1");
	await expect(
		page.getByRole("button", { name: "Replay", exact: true }),
	).toHaveCount(0);
	await page.getByRole("tab", { name: "Payload" }).click();
	await expect(page.getByText(/payload.read permission/)).toBeVisible();
	expect(fixture.payloadRequests()).toHaveLength(0);
	fixture.setRole("operator");
	await page.goto("/events/evt_1");
	await page.getByRole("tab", { name: "Payload" }).click();
	expect(fixture.payloadRequests()).toHaveLength(0);
	await page.getByRole("button", { name: "Show payload" }).click();
	await expect(page.getByRole("tabpanel")).toContainText("ok");
	expect(fixture.payloadRequests()).toHaveLength(1);
	const replay = page.getByRole("button", { name: "Replay", exact: true });
	await replay.click();
	await expect(
		page.getByRole("dialog", { name: "Replay delivery" }),
	).toBeVisible();
	await expect(page.getByLabel("Reason")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(replay).toBeFocused();
});

test("delivery without attempts explains why no response is available", async ({
	page,
}) => {
	const original = rows.eventDetail().deliveries[0];
	await installApp(page, {
		eventDetail: rows.eventDetail({
			deliveries: [
				{
					...original,
					status: "queued",
					attempt_count: 0,
					last_http_status: null,
					last_error: null,
					completed_at: null,
					attempts: [],
				},
			],
		}),
	});
	await page.goto("/events/evt_1");
	const inspector = page.getByRole("region", {
		name: "Request & response inspector",
	});
	await expect(inspector).toContainText("Delivery dlv_1 · No attempts yet");
	await expect(inspector).toContainText(
		"No attempt is available for inspection.",
	);
	await expect(
		page.getByRole("region", { name: "Delivery dlv_1" }),
	).toContainText("awaiting an attempt");
});

test("production-shaped long IDs stay contained on overview and detail at 390, 1024 and 1440", async ({
	page,
}, testInfo) => {
	const stress = stressDataset();
	await page.emulateMedia({ reducedMotion: "reduce" });
	await installApp(page, {
		username: stress.longAccountName,
		sourceDetail: stress.sources[0],
		destinationDetail: stress.destinations[0],
		events: { kind: "data", items: stress.events },
		eventDetail: stress.eventDetail,
		failures: { kind: "data", items: stress.failures },
		sources: { kind: "data", items: stress.sources },
		destinations: { kind: "data", items: stress.destinations },
	});
	for (const width of [1440, 1024, 390]) {
		await page.setViewportSize({ width, height: 900 });
		await page.goto("/");
		const row = page.getByRole("row").filter({ hasText: stress.longEventId });
		await expect(row.getByText(stress.longEventId)).toBeVisible();
		if (width === 390)
			await expect(row.getByText("Dead letter", { exact: true })).toBeVisible();
		expect(await pageOverflow(page), `overview ${width}px`).toBe(0);
		await testInfo.attach(`reliability-overview-${width}`, {
			body: await page.screenshot({
				fullPage: true,
				path: `../../.superpowers/sdd/dashboard-reliability-console-plan/visual-evidence/overview-${width}.png`,
			}),
			contentType: "image/png",
		});
		await page.goto(`/events/${stress.longEventId}`);
		await expect(page.locator("h1")).toContainText(stress.longEventId);
		const context = page.getByRole("region", {
			name: "Event delivery context",
		});
		await expect(context).toContainText(stress.longSourceName);
		await expect(context).toContainText(stress.longDestinationName);
		await expect(context).toContainText("Dead letter");
		await expect(
			page.getByRole("button", { name: "Replay", exact: true }),
		).toBeVisible();
		if (width === 390) {
			const trigger = page.getByRole("button", { name: "Open navigation" });
			await expect(trigger).toBeVisible();
			await trigger.click();
			const drawer = page.getByRole("dialog", { name: "Navigation" });
			await expect(drawer.getByTitle(stress.longAccountName)).toHaveCount(0);
			await page.keyboard.press("Escape");
		} else {
			const nav = page.getByRole("navigation", { name: "Main" });
			await expect(nav).toBeVisible();
		}
		const account = page
			.getByRole("banner")
			.getByRole("button", { name: /^Account:/ });
		await expect(account).toHaveAccessibleName(
			`Account: ${stress.longAccountName}, admin`,
		);
		await expect(page.getByRole("menu")).toBeHidden();
		await account.click();
		await expect(
			page.getByRole("menuitem", { name: "Change password" }),
		).toBeVisible();
		await expect(page.getByRole("menuitem", { name: "Log out" })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(account).toBeFocused();
		expect(await pageOverflow(page), `detail ${width}px`).toBe(0);
		await testInfo.attach(`reliability-detail-${width}`, {
			body: await page.screenshot({
				fullPage: true,
				path: `../../.superpowers/sdd/dashboard-reliability-console-plan/visual-evidence/detail-${width}.png`,
			}),
			contentType: "image/png",
		});
		if (width === 1024)
			await expect(
				page.getByRole("navigation", { name: "Main" }),
			).toBeVisible();
	}
});
test("opens the project picker by keyboard with a long name at 320px", async ({
	page,
}) => {
	const name =
		"International Payments and Settlement Reconciliation for Europe";
	await page.setViewportSize({ width: 320, height: 840 });
	await installApp(page, {
		projects: { kind: "data", items: [rows.project({ name })] },
	});
	await page.goto("/settings");
	const picker = page.getByRole("combobox", { name: "Active project" });
	await expect(picker).toBeVisible();
	await picker.press("Space");
	const list = page.getByRole("listbox");
	await expect(list).toBeVisible({ timeout: 3_000 });
	await expect(
		list.getByRole("option", { name, selected: true, exact: true }),
	).toBeVisible();
	const listBox = await list.boundingBox();
	if (!listBox) throw new Error("Project listbox is not visible");
	expect(listBox.x).toBeGreaterThanOrEqual(0);
	expect(listBox.x + listBox.width).toBeLessThanOrEqual(320);
	await page.keyboard.press("Escape");
	await expect(list).toBeHidden();
	await expect(picker).toBeFocused();
	const breadcrumb = page.getByRole("navigation", { name: /breadcrumb/i });
	await expect(breadcrumb).toBeVisible();
	const pickerBox = await picker.boundingBox();
	const breadcrumbBox = await breadcrumb.boundingBox();
	if (!pickerBox || !breadcrumbBox) throw new Error("Header layout is missing");
	expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(breadcrumbBox.x);
	expect(await pageOverflow(page)).toBe(0);
});

test("switches projects without scoping deployment pages", async ({ page }) => {
	const { requests } = await installApp(page, {
		projects: {
			kind: "data",
			items: [
				rows.project({ name: "Payments" }),
				rows.project({ id: "prj_2", name: "Shipping" }),
			],
		},
		sources: {
			kind: "data",
			items: [
				rows.source({ name: "Payments webhook" }),
				rows.source({
					id: "src_2",
					project_id: "prj_2",
					name: "Shipping webhook",
				}),
			],
		},
	});
	const picker = page.getByRole("combobox", { name: "Active project" });
	await page.goto("/endpoints?tab=sources&project_id=prj_1");
	await expect(
		page.getByRole("link", { name: "Payments webhook" }),
	).toBeVisible();
	await picker.click();
	await page.getByRole("option", { name: "Shipping", exact: true }).click();
	await expect(page).toHaveURL(/project_id=prj_2/);
	await expect(
		page.getByRole("link", { name: "Shipping webhook" }),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Payments webhook" }),
	).toHaveCount(0);
	await page.reload();
	await expect(picker).toHaveText("Shipping");
	await page.goBack();
	await expect(picker).toHaveText("Payments");
	await expect(
		page.getByRole("link", { name: "Payments webhook" }),
	).toBeVisible();

	await page.goto("/projects");
	await expect(page.getByRole("link", { name: "Payments" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Shipping" })).toBeVisible();
	await picker.click();
	await page.getByRole("option", { name: "Shipping", exact: true }).click();
	await expect(page).toHaveURL(/\/projects$/);
	for (const path of ["/archives", "/audit"]) {
		await page.goto(path);
		await expect(picker).toHaveText("Shipping");
		await expect(page.getByText(/deployment-wide/i)).toBeVisible();
	}
	await page.goto("/settings?tab=storage");
	await expect(
		page.getByRole("heading", { name: "Archive runs" }),
	).toBeVisible();
	for (const { path } of requests.filter((r) =>
		/^\/(settings|backups|archives|audit-logs)\b/.test(r.path),
	)) {
		expect(path).not.toContain("project_id");
	}

	for (const width of [1440, 390]) {
		await page.setViewportSize({ width, height: 840 });
		await page.goto("/");
		const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
		await expect(breadcrumb).toHaveText("Overview");
		await expect(picker).toHaveText("Shipping");
		const a = await picker.boundingBox();
		const b = await breadcrumb.boundingBox();
		expect(a && b && a.x + a.width <= b.x).toBe(true);
		await expect(page.getByText("Current deployment")).toHaveCount(0);
		if (width === 390) {
			await page.getByRole("button", { name: "Open navigation" }).click();
			await expect(
				page.getByRole("dialog").getByText("Hookflare instance"),
			).toHaveCount(0);
		}
	}
});
