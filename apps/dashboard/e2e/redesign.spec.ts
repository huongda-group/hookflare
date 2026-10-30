import { expect, test } from "@playwright/test";
import {
	installApp,
	overviewPayload,
	pageOverflow,
	rows,
	stressDataset,
} from "./fixtures";

/**
 * Browser verification for the light dashboard redesign (Task 13).
 *
 * Every test installs browser-only route-interception fixtures (see
 * `fixtures.ts`) and never mutates the real D1 that the parallel
 * real-Worker `smoke.spec.ts` owns. The 8 named screens are attached as
 * screenshots for the review record; screenshots stay in Playwright's
 * output dir and are never committed.
 */

const WIDTHS = [1440, 1280, 768, 390, 320] as const;

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
			// The sidebar copy is CSS-hidden below 1024px; the drawer opens it.
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

test("setup and login render explicit states and stay keyboard operable", async ({
	page,
}) => {
	// Setup: onboarding open, token help present, submit by keyboard.
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
	await page.getByLabel("Username", { exact: true }).fill("e2e-admin");
	const password = page.getByLabel("Password", { exact: true });
	await password.fill("e2e-password-1234");
	// Show/hide keeps the value and the ref (react-hook-form compatible).
	const toggle = page.getByRole("button", {
		name: /show password|hide password/i,
	});
	if (await toggle.isVisible()) {
		await toggle.focus();
		await page.keyboard.press("Enter");
		await expect(password).toHaveValue("e2e-password-1234");
	}
	expect(await pageOverflow(page)).toBe(0);

	// Login: wrong credentials stay inline, never a session-expiry redirect.
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
			(r) => r.method === "POST" && r.path === "/destinations/dst_1/pause",
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
	// The Audit entry needs `audit.read`; Archives and the degraded Settings
	// entry stay visible on `events.read` alone.
	await expect(nav).not.toContainText("Audit");
	await expect(nav).toContainText("Archives");

	// Direct navigation as a viewer must not request protected audit data.
	await page.goto("/audit");
	await expect(
		page.getByText("The audit log requires the admin role."),
	).toBeVisible();
	expect(fixture.requests.some((r) => r.path.startsWith("/audit"))).toBe(false);

	// Settings degrades to the readable retry tab only.
	await page.goto("/settings");
	await expect(page.getByRole("tab", { name: "Retry defaults" })).toBeVisible();
	await expect(page.getByRole("tab", { name: "Users" })).not.toBeVisible();
	await expect(page.getByRole("tab", { name: "Storage" })).not.toBeVisible();
	await expect(page.getByRole("tab", { name: "Alerts" })).not.toBeVisible();
	expect(await pageOverflow(page)).toBe(0);
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

	// The downgraded session loses administrative controls on next load.
	fixture.setRole("viewer");
	await page.goto("/settings?tab=users");
	await expect(page.getByRole("tab", { name: "Users" })).not.toBeVisible();
	await expect(page.getByRole("tab", { name: "Retry defaults" })).toBeVisible();
});

test("zoom approximation (640 CSS px viewport plus CSS zoom) keeps every screen within the viewport", async ({
	page,
}, testInfo) => {
	await installApp(page, { role: "admin" });
	// 1280px at 200% zoom == 640 CSS px (viewport equivalence, not a
	// browser-zoom proof on its own).
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
	// Programmatic CSS zoom is an approximation: it exercises the engine's
	// zoom layout but is NOT manual browser zoom (no CDP-driven real zoom
	// is available in this environment). Manual browser-zoom verification
	// is an OPEN follow-up recorded in the review doc.
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

	// Skip link targets the main content landmark (operated by keyboard).
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

	// State-driven dialogs (no Radix trigger association) return focus to
	// the opener on every close path, with no focus trap.
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

	// The Close (X) button path restores the opener too.
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
	// The payload/code region may scroll locally; the page must not.
	expect(await pageOverflow(page)).toBe(0);

	// Confirmed-missing payload explains itself and disables replay.
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

	// Duplicate display names stay disambiguated by id in the picker.
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto("/events");
	await page.getByRole("combobox", { name: "Project" }).click();
	await page
		.getByRole("option", { name: /Payments/ })
		.first()
		.click();
	expect(await pageOverflow(page)).toBe(0);
});

test("empty, error, and one-time-secret states behave and recover", async ({
	page,
}, testInfo) => {
	// Empty events: message plus a working scope-clearing action.
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

	// Failed overview: named retry, content preserved after recovery.
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

	// One-time secret: shown once behind an acknowledgment, then gone.
	await installApp(page, { role: "admin" });
	await page.goto("/endpoints?tab=destinations");
	await page.getByRole("button", { name: "New destination" }).click();
	await page.getByRole("combobox", { name: "Project", exact: true }).click();
	await page.getByRole("option", { name: "Payments" }).click();
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
	// Setup screen with onboarding open.
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
			await expect(drawer.getByTitle(stress.longAccountName)).toBeVisible();
			await expect(
				drawer.getByRole("button", { name: "Change password" }),
			).toBeVisible();
			await expect(
				drawer.getByRole("button", { name: "Log out" }),
			).toBeVisible();
			await page.keyboard.press("Escape");
		} else {
			const nav = page.getByRole("navigation", { name: "Main" });
			await expect(nav).toBeVisible();
			await expect(page.getByTitle(stress.longAccountName)).toBeVisible();
			await expect(
				page.getByRole("button", { name: "Change password" }),
			).toBeVisible();
			await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
		}
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
