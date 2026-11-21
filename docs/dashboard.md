# Dashboard design system

[Documentation index](README.md)

## Business rules and current behavior

The dashboard is an internal operations interface built with React, Vite, Tailwind, and TanStack Router/Query. It supports setup, login, overview, projects, endpoints, events, failures, alerts, archives, audit, settings, and account dialogs. The implemented visual direction is a single light theme.

The Reliability Console gives operators two entry points: [Overview](overview.md) surfaces destinations that need investigation, and [Event detail](events.md) connects the source to a delivery, an attempt, and its outcome. Other authenticated routes share the shell and use their own task layouts.

## Design and interaction

Use semantic color tokens from `index.css`, an understated canvas, clear foreground hierarchy, consistent panel/control radii, strong active navigation, and textual status labels alongside color. Desktop sidebar starts at 1024px; narrower layouts use a navigation drawer. Tables scroll inside their region, not the whole page.

Every data view distinguishes loading, empty, failure, and loaded states. Forms need labels, pending state, inline validation, focus restoration, and safe handling of unsaved work. Protected actions require server permission checks. Reveal payloads explicitly and secrets only once.

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

### Proposed logo exploration

The dashboard already serves favicon and install icons from `public/`; the shell and auth layout display the lowercase `hookflare` wordmark. An optional future comparison could evaluate five alternate SVG marks: forwarding flow, connected nodes, retry loop, protected route, and an H monogram. Keep the treatments comparable with navy `#253B69`, blue `#245BDB`, and restrained geometry. The marks should remain distinct at small sizes and communicate webhook delivery and recovery without suggesting fan-out.

If explored, keep the SVGs and a standalone comparison sheet outside application source. Review small-size legibility, independent SVG rendering, accessible titles, and wordmark consistency before deciding whether to replace the existing wordmark.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/dashboard/src/index.css](../apps/dashboard/src/index.css)
- [apps/dashboard/index.html](../apps/dashboard/index.html)
- [apps/dashboard/public/site.webmanifest](../apps/dashboard/public/site.webmanifest)
- [apps/dashboard/src/components/AppShell.tsx](../apps/dashboard/src/components/AppShell.tsx)
- [apps/dashboard/src/components/ui/dialog.tsx](../apps/dashboard/src/components/ui/dialog.tsx)
- [apps/dashboard/e2e/redesign.spec.ts](../apps/dashboard/e2e/redesign.spec.ts)
- [apps/dashboard/e2e/smoke.spec.ts](../apps/dashboard/e2e/smoke.spec.ts)
