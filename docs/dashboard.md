# Dashboard design system

[Documentation index](README.md)

## Business rules and current behavior

The dashboard is an internal operations interface built with React, Vite, Tailwind, and TanStack Router/Query. It supports setup, login, overview, projects, endpoints, events, failures, alerts, archives, audit, settings, and account dialogs. The implemented visual direction is a single light theme.

The Reliability Console gives operators two entry points: [Overview](overview.md) surfaces destinations that need investigation, and [Event detail](events.md) connects the source to a delivery, an attempt, and its outcome. Other authenticated routes share the shell and use their own task layouts.

`/setup` and `/login` render outside the app shell. Before any route renders, the root loader reads `GET /auth/state`: while onboarding is open every route redirects to `/setup`, and once it is closed `/setup` redirects to `/login` (see [login](login.md)). Any `401` from the admin API sends the user to `/login?next=<current URL>`, except the public `/auth/*` routes and a `wrong_password` answer from the password change, which are form errors shown inline. `next` is honored only for a same-origin absolute dashboard path that is not `/login` or `/setup`; anything else lands on `/`, because the parameter is attacker-controllable. Sign-out asks for confirmation, then clears every cached query and lands on `/login` even if the logout request fails, so a failed logout never traps the user.

Until the first project exists, `/me` reports `project_required` and the server answers every other admin route except `GET`/`POST /projects` with `409 project_required`. The shell redirects every route to `/projects`, hides the navigation, the project selector, and Change password, and shows a prompt: users with `config.write` are asked to create the first project; everyone else is asked to wait for an admin.

## Design and interaction

Use semantic color tokens from `index.css`, an understated canvas, clear foreground hierarchy, consistent panel/control radii, strong active navigation, and textual status labels alongside color. Desktop sidebar starts at 1024px; narrower layouts use a navigation drawer that closes when a destination is chosen. Tables scroll inside their region, not the whole page.

Navigation has three groups: **Monitor** (Overview, Events, Failures, Alerts), **Configure** (Projects, Endpoints), and **Administer** (Archives, Audit, Settings). Visibility is decided by permission, never by role name: each group needs `events.read`, and Audit also needs `audit.read`. The UI hides actions the user cannot perform rather than disabling them, and the server still enforces every permission. A `403` during a session shows a permission-denied toast and refetches `/me`, so a downgraded role loses its navigation entries and actions on the next render.

The sidebar and drawer highlight the current section by URL path, regardless of filters or tabs in the query string. Overview is active only at `/`; detail pages highlight their parent section. The active item uses a background and heavier text, not color alone. Breadcrumbs are derived from the path: known parent sections link to their route, and a trailing detail ID is shown as text.

The **Active project** selector sits immediately before the breadcrumb on desktop and mobile. Its compact trigger shows a folder icon and the current project name. Long names may be shortened in the trigger; the open menu shows the full labels and marks the current project with a check, and projects that share a name are listed as `name (id)`. Overview, Endpoints, Events, Failures, project alerts, and the event, source, destination, and project-alert detail pages use the selected project; there is no cross-project option in those views. Navigation and breadcrumb links to project views carry `project_id`, and a project view opened without one gets the resolved project added to its URL. A valid `project_id` in the URL takes precedence over the last selection in this browser (stored in `localStorage`; the in-memory selection still works when storage is blocked). If neither supplies a project, the dashboard selects the first available one. Disabled projects are selectable. An unavailable explicit project, or more than one `project_id`, prompts for a new selection instead of falling back to unfiltered data. Switching projects clears resource filters (source, destination, provider event ID), pagination, and selected rows, and keeps status, HTTP status, time range, and tab filters; a switch on a detail page returns to its collection.

Project scope is one shared selection enforced by the server: project views pass `project_id` explicitly (see [the contract](contract.md)), so filtering, counts, pagination, and actions are scoped before results reach the browser. Filtering in the browser or keeping per-page project filters was rejected because filters could disagree and counts or bulk actions could include another project's data. Giving each project its own settings, jobs, and permissions was also rejected; projects are not tenants. Project-view data is not requested until the selection is resolved, and a failed catalog load shows a retryable error. React Query keys include the project scope and the page remounts on a switch, so a switch never shows the prior project's cached rows, reuses its cursor, or retargets a pending action. Cached data is cleared at sign-out.

[Projects](projects.md) is a shared catalog. Account, users, API tokens, settings, backups, archives, and audit are deployment-wide. Selecting a project on those pages changes the selection for the next project view, not the data on the current page. [Alerts](alerts.md) lists deployment incidents separately.

Every data view distinguishes loading, empty, failure, and loaded states. The shared [`DataState`](../apps/dashboard/src/components/DataState.tsx) panel renders a geometry-stable skeleton with an accessible `Loading` status and no placeholder values while loading; an initial failure shows a readable explanation, the error code, and Retry (never an empty or success state); a failed background refresh keeps the loaded data on screen with a warning and Retry. The Settings › Alerts channel list uses it, so a failed load shows an error with Retry instead of `0 channel(s)`. Empty states say what is missing and offer the next action the user is allowed to take. Cursor lists use **Load more**, never page numbers; a failed next page keeps the loaded rows and retries only that page. Each row's resource cell is a real link, so every row has a keyboard path to its resource. Queries do not retry automatically and refetch on window focus; Overview refreshes every 15 seconds, event detail every 15 seconds while a delivery can still change, and alerts every minute, only while the tab is visible.

Forms need labels, pending state, inline validation, focus restoration, and safe handling of unsaved work. Server validation `issues` are shown on the same fields as client validation, and after a failed setup or login submit the first invalid field receives focus. Configuration forms (projects, sources, destinations, settings tabs, user dialogs) warn before discarding unsaved changes: in-app navigation and dialog close prompt while the form is dirty (checkbox toggles count as edits), a `beforeunload` guard is attached only while dirty, and a successful save lets the pending close or navigation through without a prompt. Edit dialogs unmount on close, so every open starts from the current values. An empty optional policy field means "use the default", and emptying it on edit sends `null`. Passwords are never trimmed; the show/hide toggle only switches the input type and never submits the form.

Write buttons (alert-channel Save, archive Run now, Run backup now, the storage Save anyway confirmation, Replay) stay disabled while their request is in flight, so a double click sends one request; the Replay dialog cannot be dismissed until its request settles. A storage confirmation describes the values at submit time, so any further edit drops it instead of saving unreviewed values. Confirm dialogs ask for a reason only when the route records it: deleting an alert channel sends the typed reason, and revoking an API token shows no reason field. Reason fields validate 1–500 characters inline without a browser length cap, so over-long input is reported rather than silently truncated. Protected actions require server permission checks.

Reveal payloads explicitly and secrets only once. A one-time secret dialog cannot be closed until the user confirms they stored the secret; the value lives only in the dialog's state and is dropped on close. Write-only configuration such as alert channel configs is never shown again; on edit, an empty field keeps the stored value. Stored payloads load only after an explicit Show and never refetch in the background (see [events](events.md)). JSON is rendered as text nodes, never as markup, with disclosure buttons instead of an ARIA tree; JSON bodies also offer the exact raw text, because parsing rounds integers beyond `Number.MAX_SAFE_INTEGER`. Archive part downloads are plain same-origin links so the browser streams the file with the session cookie.

Use [`FormField`](../apps/dashboard/src/components/FormField.tsx) for a label stacked above a control. It provides an 8px gap and keeps field-specific help and validation in the same group. Use a plain label for checkbox and switch rows that place the label beside the control. Use `FormSection` for titled groups inside a form or detail panel; each page has a single `<h1>` from `PageHeader`.

The dashboard API client shows one outcome toast per `POST`, `PUT`, `DELETE`, or `PATCH` request. Toasts name the action (for example, `Login session`, `Project updated`, or `Could not save alert rules`); a write without specific copy uses `Action completed.` or `Action failed.`, and an unexpected `202` uses `Request accepted.`. Replay, backup, and archive toasts acknowledge the request rather than declaring background work complete. Test delivery and alert-channel toasts announce that the test finished; the result is shown inline. Network errors and `403` responses use shared messages, read requests do not show outcome toasts, and forms still show validation and error details inline. The toasts come from the shared API client rather than per-feature handlers, so every write request is covered; one toast host is mounted at the router root so messages survive redirects between login, setup, and the dashboard. Toasts use fixed copy and never include resource IDs or request or response contents.

Names are shown where available and IDs for disambiguation. Resource labels read names only from pages already cached by a picker and never fetch for a label; a missing permission, deleted resource, or unloaded page falls back to the exact ID. Resource pickers are accessible comboboxes that filter loaded options, load more pages on request, and accept an exact ID; Enter in the picker search never submits the surrounding form. Creating or renaming a project refreshes cached project names, as source and destination changes already do for theirs. Copyable IDs stay visible and selectable; if the clipboard is unavailable the user is told to copy manually, never shown a false `Copied`. Relative times expose the exact browser-local and UTC timestamps on hover, keyboard focus, and tap. Every status uses one label, icon, and color everywhere, so status never depends on color alone; an unknown status or alert rule renders its raw value in a neutral badge. The trend chart dashes the failed series and carries a text summary.

IDs and long URLs must wrap safely. Dialogs close with Escape and restore focus, including dialogs opened from state rather than a trigger, which return focus to the element that opened them. Provide a skip link and landmarks. Do not claim accessibility certification from calculated token contrast or fixture screenshots.

Implemented token values are listed below. Page-specific behavior lives in the corresponding feature document.

## Implemented visual tokens

These are the semantic values in `index.css`. This table does not certify accessibility.

| Token | Value | Used on |
| --- | --- | --- |
| `--canvas` | `#F7F8FA` | App background |
| `--surface` | `#FFFFFF` | Cards, dialogs, table panels |
| `--sidebar` | `#F1F3F7` | Navigation sidebar |
| `--border` / `--input` | `#E3E7ED` / `#D4DCE7` | Separators and controls |
| `--foreground` / `--muted-foreground` | `#202733` / `#667080` | Body and secondary text |
| `--action` / `--action-hover` / `--action-foreground` | `#245BDB` / `#1C4CBD` / `#FFFFFF` | Primary buttons and links |
| `--selected` / `--selected-foreground` | `#E1E9FB` / `#244DA7` | Active navigation |
| `--accent` | `#E8ECF3` | Hover surface for ghost and outline controls and menu items |
| `--success` / `--success-surface` | `#23704D` / `#E9F5ED` | Delivered status |
| `--warning` / `--warning-surface` | `#805316` / `#FFF2DA` | Retrying status, stale-data warnings |
| `--failure` / `--failure-surface` | `#A43737` / `#FBE6E5` | Terminal failure status |
| `--info` / `--info-surface` | `#244DA7` / `#EDF2FF` | Informational status |
| `--avatar` / `--avatar-foreground` | `#DFE5EF` / `#4A5974` | Account menu avatar |
| `--brand` | `#253B69` | Defined with a `brand` alias; no component uses it |
| `--focus` | `#245BDB` | Visible keyboard focus |
| `--chart-received` / `--chart-delivered` / `--chart-failed` | `#426CCC` / `#47A083` / `#D0847E` | Chart series; textual alternatives remain |

Components use the Tailwind aliases of these tokens, never raw palette values; the shadcn/ui names (`bg-background`, `bg-primary`, and so on) map to the same values. Semantic foregrounds are darker than the decorative chart strokes so labels stay legible on tinted surfaces.

Radii: `--radius-control: 0.5rem` (8px controls), `--radius-panel: 0.625rem` (10px panels). System UI fonts are used for interface text and system monospace only for IDs, code, JSON, hashes, and measured values. Body text is 14px, and 15px below 768px. Buttons and inputs are 40px high (44px for the large size); on a coarse (touch) pointer every interactive control has at least a 44px target, and checkboxes and radios keep their small box with an enlarged invisible hit area. Keyboard focus is a 2px outline with a 2px offset. Transitions are short and limited to focus, hover, and disclosure, and reduced-motion preferences disable them. `PageHeader`, `StatusBadge`, `AppShell`, `OverviewAttention`, `RecentEventsTable`, `EventDeliveryContext`, `DeliveryTimeline`, and `EventInspector` compose the shared visual vocabulary. There is no dark theme or remote font: the page declares `color-scheme: light`, the toaster uses a fixed light theme, and the `dark:` variant applies only under a `.dark` class that is never set, so an OS dark preference cannot restyle individual controls.

## Ideas, boundaries, and open work

Dark/system themes and extra mobile-specific product scope are not implemented commitments. Fixture browser tests check that navigation causes no page overflow from 1440px down to 320px, that long IDs stay contained at 390px, 1024px, and 1440px, and approximate 200% zoom with a 640 CSS px viewport and with CSS `zoom: 200%`. Manual browser-zoom verification remains open. The separate smoke suite uses a real local Worker and D1; fixture tests do not.

## Branding

The dashboard sidebar and the shared sign-in and setup layout use the same SVG mark as the browser favicon, alongside the lowercase `hookflare` wordmark. Browser fallback and install icons use the same artwork and are served from `apps/dashboard/public/`. The sign-in and setup illustration shows the real event → delivery → attempt relationship without invented activity data.

Each dashboard route sets the browser's HTML title to `Page name · Hookflare`. Detail routes use their page type so the title is available during loading and error states. The initial HTML and unmatched routes use `Hookflare`.

## Source and verification entry points

Component, page, and library tests run with Vitest under `apps/dashboard/tests/`. The Playwright suites run against `wrangler dev` on port 8788 with a fresh local D1 and the Turnstile test keys. The fixture suite (`redesign.spec.ts`) intercepts API routes and never touches D1; the live suite (`smoke.spec.ts`) drives the real Worker from onboarding through the first project to a dead-lettered delivery. Run them in separate processes (`pnpm --filter dashboard e2e redesign.spec.ts`, then `pnpm --filter dashboard e2e smoke.spec.ts`) so they cannot share Worker state.

The files below define this behavior and its tests.

- [apps/dashboard/src/index.css](../apps/dashboard/src/index.css)
- [apps/dashboard/index.html](../apps/dashboard/index.html)
- [apps/dashboard/public/site.webmanifest](../apps/dashboard/public/site.webmanifest)
- [apps/dashboard/src/routes/__root.tsx](../apps/dashboard/src/routes/__root.tsx)
- [apps/dashboard/src/components/AppShell.tsx](../apps/dashboard/src/components/AppShell.tsx)
- [apps/dashboard/src/components/AppNavigation.tsx](../apps/dashboard/src/components/AppNavigation.tsx)
- [apps/dashboard/src/lib/project-selection.tsx](../apps/dashboard/src/lib/project-selection.tsx)
- [apps/dashboard/src/lib/api.ts](../apps/dashboard/src/lib/api.ts)
- [apps/dashboard/src/lib/write-toast.ts](../apps/dashboard/src/lib/write-toast.ts)
- [apps/dashboard/src/components/DataState.tsx](../apps/dashboard/src/components/DataState.tsx)
- [apps/dashboard/src/components/DirtyFormGuard.tsx](../apps/dashboard/src/components/DirtyFormGuard.tsx)
- [apps/dashboard/src/components/ui/dialog.tsx](../apps/dashboard/src/components/ui/dialog.tsx)
- [apps/dashboard/tests/components/AppShell.test.tsx](../apps/dashboard/tests/components/AppShell.test.tsx)
- [apps/dashboard/tests/lib/project-selection.test.tsx](../apps/dashboard/tests/lib/project-selection.test.tsx)
- [apps/dashboard/tests/lib/write-toast.test.ts](../apps/dashboard/tests/lib/write-toast.test.ts)
- [apps/dashboard/tests/project-onboarding.test.tsx](../apps/dashboard/tests/project-onboarding.test.tsx)
- [apps/dashboard/tests/page-titles.test.tsx](../apps/dashboard/tests/page-titles.test.tsx)
- [apps/dashboard/tests/e2e/redesign.spec.ts](../apps/dashboard/tests/e2e/redesign.spec.ts)
- [apps/dashboard/tests/e2e/smoke.spec.ts](../apps/dashboard/tests/e2e/smoke.spec.ts)
