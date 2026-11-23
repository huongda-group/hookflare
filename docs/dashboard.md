# Dashboard design system

[Documentation index](README.md)

## Business rules and current behavior

The dashboard is an internal operations interface built with React, Vite, Tailwind, and TanStack Router/Query. It supports setup, login, overview, projects, endpoints, events, failures, alerts, archives, audit, settings, and account dialogs. The implemented visual direction is a single light theme.

The Reliability Console gives operators two entry points: [Overview](overview.md) surfaces destinations that need investigation, and [Event detail](events.md) connects the source to a delivery, an attempt, and its outcome. Other authenticated routes share the shell and use their own task layouts.

## Design and interaction

Use semantic color tokens from `index.css`, an understated canvas, clear foreground hierarchy, consistent panel/control radii, strong active navigation, and textual status labels alongside color. Desktop sidebar starts at 1024px; narrower layouts use a navigation drawer. Tables scroll inside their region, not the whole page.

The sidebar and drawer highlight the current section by URL path, regardless of filters or tabs in the query string. Overview is active only at `/`; detail pages highlight their parent section.

The **Active project** selector sits immediately before the breadcrumb on desktop and mobile. Its compact trigger shows a folder icon and the current project name. Long names may be shortened in the trigger; the open menu shows the full labels and marks the current project with a check. Overview, Endpoints, Events, Failures, and project incidents use the selected project; there is no cross-project option in those views. A valid `project_id` in the URL takes precedence over the last selection in this browser. If neither supplies a project, the dashboard selects the first available one. Disabled projects remain selectable. An unavailable explicit project prompts for a new selection instead of falling back to unfiltered data. Switching projects resets resource filters, pagination, and selected rows; a switch on a detail page returns to its collection.

[Projects](projects.md) is a shared catalog. Account, users, API tokens, settings, backups, archives, and audit are deployment-wide. Selecting a project on those pages changes the selection for the next project view, not the data on the current page. [Alerts](alerts.md) lists deployment incidents separately.

Every data view distinguishes loading, empty, failure, and loaded states. Forms need labels, pending state, inline validation, focus restoration, and safe handling of unsaved work. Protected actions require server permission checks. Reveal payloads explicitly and secrets only once.

Use [`FormField`](../apps/dashboard/src/components/FormField.tsx) for a label stacked above a control. It provides an 8px gap and keeps field-specific help and validation in the same group. Use a plain label for checkbox and switch rows that place the label beside the control.

The dashboard API client shows one outcome toast per `POST`, `PUT`, `DELETE`, or `PATCH` request. Toasts name the action (for example, `Login session`, `Project updated`, or `Could not save alert rules`). Replay, backup, and archive toasts acknowledge the request rather than declaring background work complete. Test delivery and alert-channel toasts announce that the test finished; the result is shown inline. Network and permission messages remain shared, read requests do not show outcome toasts, and forms still show validation and error details inline.

IDs and long URLs must wrap safely; use names where available and IDs for disambiguation. Dialogs close with Escape and restore focus. Provide a skip link and landmarks. Do not claim accessibility certification from calculated token contrast or fixture screenshots.

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
| `--action` / `--action-hover` | `#245BDB` / `#1C4CBD` | Primary buttons and links |
| `--selected` / `--selected-foreground` | `#E1E9FB` / `#244DA7` | Active navigation |
| `--success` / `--success-surface` | `#23704D` / `#E9F5ED` | Delivered status |
| `--warning` / `--warning-surface` | `#805316` / `#FFF2DA` | Retrying status |
| `--failure` / `--failure-surface` | `#A43737` / `#FBE6E5` | Terminal failure status |
| `--focus` | `#245BDB` | Visible keyboard focus |
| `--chart-received` / `--chart-delivered` / `--chart-failed` | `#426CCC` / `#47A083` / `#D0847E` | Chart series; textual alternatives remain |

Radii: `--radius-control: 0.5rem` (8px controls), `--radius-panel: 0.625rem` (10px panels). System UI fonts are used for text and system monospace for technical identifiers. `PageHeader`, `StatusBadge`, `AppShell`, `OverviewAttention`, `RecentEventsTable`, `EventDeliveryContext`, `DeliveryTimeline`, and `EventInspector` compose the shared visual vocabulary. There is no dark theme or remote font.

## Ideas, boundaries, and open work

Dark/system themes and extra mobile-specific product scope are not implemented commitments. Fixture browser tests cover responsive containment at 390px, 1024px, and 1440px and approximate 200% zoom. Manual browser-zoom verification remains open. The separate smoke suite uses a real local Worker and D1; fixture tests do not.

## Branding

The dashboard sidebar and the shared sign-in and setup layout use the same SVG mark as the browser favicon, alongside the lowercase `hookflare` wordmark. Browser fallback and install icons use the same artwork and are served from `apps/dashboard/public/`.

Each dashboard route sets the browser's HTML title to `Page name · Hookflare`. Detail routes use their page type so the title is available during loading and error states. The initial HTML and unmatched routes use `Hookflare`.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/dashboard/src/index.css](../apps/dashboard/src/index.css)
- [apps/dashboard/index.html](../apps/dashboard/index.html)
- [apps/dashboard/public/site.webmanifest](../apps/dashboard/public/site.webmanifest)
- [apps/dashboard/src/components/AppShell.tsx](../apps/dashboard/src/components/AppShell.tsx)
- [apps/dashboard/src/components/ui/dialog.tsx](../apps/dashboard/src/components/ui/dialog.tsx)
- [apps/dashboard/e2e/redesign.spec.ts](../apps/dashboard/e2e/redesign.spec.ts)
- [apps/dashboard/e2e/smoke.spec.ts](../apps/dashboard/e2e/smoke.spec.ts)
