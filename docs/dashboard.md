# Dashboard design system

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

The dashboard is an internal operations interface built with React, Vite, Tailwind, and TanStack Router/Query. It supports setup, login, overview, projects, endpoints, events, failures, alerts, archives, audit, settings, and account dialogs. The implemented visual direction is a single light theme.

The older product brief's “palette unapproved” and the approved spec's “not yet implemented” language describe earlier stages. Current components and the dated review supersede those statements; the review is not a fresh verification run.

## Design and interaction

Use semantic color tokens from `index.css`, an understated canvas, clear foreground hierarchy, consistent panel/control radii, strong active navigation, and textual status labels alongside color. Desktop sidebar starts at 1024px; narrower layouts use a navigation drawer. Tables scroll inside their region, not the whole page.

Every data view distinguishes loading, empty, failure, and loaded states. Forms need labels, pending state, inline validation, focus restoration, and safe handling of unsaved work. Protected actions require server permission checks. Reveal payloads explicitly and secrets only once.

IDs and long URLs must wrap safely; use names where available and IDs for disambiguation. Dialogs close with Escape and restore focus. Provide a skip link and landmarks. Do not claim accessibility certification from calculated token contrast or fixture screenshots.

Implemented token values are listed below. Page-specific behavior lives in the corresponding feature document; existing browser checks are linked under Source and verification entry points.

## Implemented visual tokens

These values come from the migrated dashboard design record; contrast values are author-side calculations, not accessibility certification. The stylesheet remains the implementation reference.

| Token | Value | Used on |
| --- | --- | --- |
| `--canvas` | `#F8FAFB` | App background |
| `--surface` | `#FFFFFF` | Cards, dialogs, table panels |
| `--sidebar` | `#F0F3F5` | Navigation sidebar |
| `--border` / `--input` | `#D6DFE6` | Separators, control outlines (1.35:1 vs white — low-emphasis only; controls also carry a visible label and a 5.8:1 focus indicator) |
| `--foreground` | `#202831` | Body text (14.1–14.9:1) |
| `--muted-foreground` | `#536371` | Secondary text (5.5–6.2:1) |
| `--action` / `--action-hover` | `#246A9E` / `#1C567F` | Primary buttons, links, focus ring (5.8:1 / 7.8:1 with white label) |
| `--selected` / `--selected-foreground` | `#DCE8F2` / `#215C87` | Active nav item (5.7:1) |
| `--success` on `--success-surface` | `#29624B` on `#EAF4EF` | (6.3:1) |
| `--warning` on `--warning-surface` | `#855B16` on `#FCF0DD` | (5.3:1) |
| `--failure` on `--failure-surface` | `#963B34` on `#FBEAE8` | (6.1:1; white on `#963B34`: 7.1:1) |
| `--focus` | `#246A9E` | Focus indicator (≥5.2:1 vs every surface) |

Radii: `--radius-control: 0.5rem` (6–8px controls), `--radius-panel: 0.75rem`
(12px panels).

## Ideas, boundaries, and open work

Dark/system themes and extra mobile-specific product scope are not implemented commitments. Manual browser zoom acceptance remains an open item in the dated review; viewport/CSS-zoom tests are not equivalent proof.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/dashboard/src/index.css](../apps/dashboard/src/index.css)
- [apps/dashboard/src/components/AppShell.tsx](../apps/dashboard/src/components/AppShell.tsx)
- [apps/dashboard/src/components/ui/dialog.tsx](../apps/dashboard/src/components/ui/dialog.tsx)
- [apps/dashboard/e2e/redesign.spec.ts](../apps/dashboard/e2e/redesign.spec.ts)
- [apps/dashboard/e2e/smoke.spec.ts](../apps/dashboard/e2e/smoke.spec.ts)

