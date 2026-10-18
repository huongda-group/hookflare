# Dashboard design (light redesign, 2026-10-18)

Single light theme. Components consume the Tailwind aliases below and never
a raw palette value (`apps/dashboard/src/index.css`). Contrast figures are
computed against the surfaces each token is used on; the full
table lives in the comment block at the top of `index.css`.
Ratios use the WCAG 2.2 contrast formula as an author-side check, not a
certification claim.

## Tokens

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

## Layout contract

- Sidebar is visible at ≥1024px (`lg:flex`); below that a top bar with an
  **Open navigation** drawer trigger.
- Skip link targets `#main-content` (`tabIndex={-1}` so keyboard activation
  moves focus there).
- Page headers wrap (`flex flex-wrap`) and picker triggers are
  `max-w-full` so 320px viewports never overflow horizontally.
- Long identifiers (event IDs) use `min-w-0 break-all`; UTC timestamps are
  abbreviated (`…Z`) with the full value in `title`.
- Tables scroll internally (`overflow-x-auto` region); the page itself must
  not scroll horizontally — enforced by `pageOverflow()` in
  `e2e/redesign.spec.ts` at 1440/1280/768/390/320px and at 640px (viewport
  equivalence for 200% zoom at 1280px, plus a CSS-zoom approximation —
  not manual browser zoom; see the review doc).

## Behaviour contracts verified by `e2e/redesign.spec.ts`

- Setup/login render explicit states; a 401 stays on `/login` with
  "Invalid username or password".
- Bulk replay reports "Awaiting enqueue" from a 201 and never claims
  "Delivered" (the API does not return delivery status synchronously).
- Destination pause/resume is a reason-confirming menu action.
- Viewer role: no Audit nav/entry, no protected audit fetch; Settings
  degrades to the Retry tab. A 403 mutation surfaces the server message.
- Payloads render only after an explicit "Show payload" action (one fetch
  per reveal); a missing payload disables replay with an explanation.
- One-time secrets (`whsec_…`) reveal once behind an acknowledgement
  checkbox.
- State-driven dialogs close on Escape and return focus to the opener via
  the app-wide `onCloseAutoFocus` restoration in `components/ui/dialog.tsx`
  (state-driven dialogs have no Radix trigger association, so the default
  would fall back to the document body). The nav drawer restores its
  trigger via its Radix `DialogTrigger` association.

## Verification split

- `e2e/redesign.spec.ts` (+ `e2e/fixtures.ts`) intercepts **every**
  `/api/admin/v1/**` request and never touches the real D1. It is the
  default browser suite.
- `e2e/smoke.spec.ts` drives the real Worker + fresh D1 (`testDb`,
  port 8788) and stays separate/sequential: project → destination →
  source creation, secret reveal, DLQ exit criteria.
- No screenshots with real payloads are committed (`test-results/` and
  `playwright-report/` are gitignored; spec attachments stay in CI output).
