# Dashboard design system

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

The dashboard is an internal operations interface built with React, Vite, Tailwind, and TanStack Router/Query. It supports setup, login, overview, projects, endpoints, events, failures, alerts, archives, audit, settings, and account dialogs. The implemented visual direction is a single light theme.

The approved [Reliability Console direction](dashboard-reliability-console.md) is implemented for the shared shell, Overview, and Event detail. Other routes retain their task layouts within the shared shell. The prototype's sample counters, simulated replay, and preview navigation are not product behavior.

## Design and interaction

Use semantic color tokens from `index.css`, an understated canvas, clear foreground hierarchy, consistent panel/control radii, strong active navigation, and textual status labels alongside color. Desktop sidebar starts at 1024px; narrower layouts use a navigation drawer. Tables scroll inside their region, not the whole page.

Every data view distinguishes loading, empty, failure, and loaded states. Forms need labels, pending state, inline validation, focus restoration, and safe handling of unsaved work. Protected actions require server permission checks. Reveal payloads explicitly and secrets only once.

IDs and long URLs must wrap safely; use names where available and IDs for disambiguation. Dialogs close with Escape and restore focus. Provide a skip link and landmarks. Do not claim accessibility certification from calculated token contrast or fixture screenshots.

Implemented token values are listed below. Page-specific behavior lives in the corresponding feature document.

## Implemented visual tokens

These are the implemented Reliability Console values in `index.css` (not the superseded light-theme palette). This table does not certify accessibility.

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

Dark/system themes and extra mobile-specific product scope are not implemented commitments. Manual browser zoom acceptance remains an open item in the dated review; viewport/CSS-zoom tests are not equivalent proof.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/dashboard/src/index.css](../apps/dashboard/src/index.css)
- [apps/dashboard/src/components/AppShell.tsx](../apps/dashboard/src/components/AppShell.tsx)
- [apps/dashboard/src/components/ui/dialog.tsx](../apps/dashboard/src/components/ui/dialog.tsx)
- [apps/dashboard/e2e/redesign.spec.ts](../apps/dashboard/e2e/redesign.spec.ts)
- [apps/dashboard/e2e/smoke.spec.ts](../apps/dashboard/e2e/smoke.spec.ts)
