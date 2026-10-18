# Review: dashboard redesign (2026-10-18)

Verification-first review of the light dashboard redesign (Tasks 1–13),
including the fix round (dialog focus restoration, proof hardening).
Scope: UI/UX and its automated proof, not the Worker pipeline.

## What was verified

- Unit: 1338 tests green across the monorepo (dashboard 362, gateway 836,
  shared 58, bench 70, sink 12), plus 91 script tests — exit 0.
- Browser, fixture suite (`apps/dashboard/e2e/redesign.spec.ts`, 12 tests):
  no page-level horizontal overflow at 1440/1280/768/390/320px and 640px
  (viewport equivalence for 200% zoom at 1280px, plus a CSS-zoom
  approximation — NOT manual browser zoom; see open follow-ups);
  setup/login states incl. inline 401; keyboard-operated bulk replay that
  reports "Awaiting enqueue" and never claims "Delivered"; reason-confirmed
  pause via the Actions menu; viewer matrix (no Audit UI, no protected audit
  fetch, Settings degrades to Retry) plus 403 feedback and downgrade;
  drawer Escape and dialog Escape/Close with focus restored to the opener;
  explicit payload reveal with request counting; stress dataset (100-char
  IDs, 200+-char URLs, duplicate names) at 390/320px; empty/error/
  one-time-secret states; 10 named screens with headings and landmarks
  (the `/login` screen is now correctly labelled `login`; `/setup` is
  captured separately).
- Browser, live suite (`e2e/smoke.spec.ts`): real Worker + fresh D1,
  project → destination → source from the UI, `whsec_` reveal, DLQ exit
  criteria. Kept separate/sequential from the fixture suite (see the
  separation mandate in `playwright.config.ts`).
- Red demonstrations: 2 deliberately failing fixture tests (temporary spec,
  deleted after the run — constrained failing fixtures, not assertion
  inversions): (a) an injected 2000px in-flow element at 320px made
  `pageOverflow()` return 1680, so the `toBe(0)` assertion failed as
  `Expected: 0 / Received: 1680`; (b) a payload fetch issued before "Show
  payload" was clicked made the request log length 1, so the committed
  `toHaveLength(0)` assertion failed as `Expected length: 0 /
  Received length: 1` with `[{"method":"GET","path":"/events/evt_1/payload"}]`.
  A first attempt at (a) with `position:fixed` measured overflow 0 — fixed
  boxes do not expand the document scroll area in Blink — and was replaced
  with normal flow, which is what a real width regression would be.
- `tsc --noEmit` (exit 0), `pnpm build` (exit 0), and biome on all touched
  files (exit 0) are clean. Repo-wide `biome check .` exits 1 identically
  at HEAD and in the worktree (80 errors, 8 warnings, 1 info —
  pre-existing format/lint drift, e.g. CursorTable a11y, EventFilters deps);
  this task adds zero new diagnostics.

## Verification with exit codes (fix round, 2026-10-18 ~11:20–11:36 UTC)

| Check | Exit | Detail |
| --- | --- | --- |
| `pnpm test` (unit + scripts) | 0 | 1338 passed (dashboard 362, gateway 836, shared 58, bench 70, sink 12), 0 failed; node script tests 91 passed, 0 failed |
| `pnpm typecheck` | 0 | all packages |
| `pnpm build` | 0 | dashboard bundle |
| `pnpm lint` (`biome check .`, repo-wide) | 1 | pre-existing: identical 80 errors / 8 warnings / 1 info at HEAD; touched files clean (exit 0) |
| `pnpm --filter dashboard e2e redesign.spec.ts` (separate run) | 0 | 12/12 passed |
| `pnpm --filter dashboard e2e smoke.spec.ts` (separate run) | 0 | 1/1 passed |
| red-demo temp spec (`e2e/red-demo.spec.ts`) | 2 failed | both failed as designed (1680 overflow; length-1 payload log); file deleted |

## Measured control and tap-target boxes (Playwright bounding boxes, Chromium, 2026-10-18 ~11:30 UTC)

Focus restoration (dialog Escape/Close → opener) and the boxes below were
inspected 2026-10-18 ~11:30 UTC against the local `wrangler dev` build of
this worktree. Desktop (1440/1280) and mobile (390/320) widths render in
the same batched suite process — viewport loops inside one test, one
browser context per test, no per-width server restart — and screenshots
attach to CI output only (never committed).

| Control | Viewport | Measured box (CSS px) |
| --- | --- | --- |
| Sidebar nav link (Overview, Events) | 1280px | 207 × 44 |
| "Open navigation" trigger | 390px | 40 × 40 |
| Drawer nav link (Events) | 390px | 255 × 44 |
| "New project" button (dialog opener) | 390px | ~112 × 40 |
| "Replay" button (event detail) | 390px | ~76 × 40 |
| Failure row checkbox (`Select dlv_1`) | 390px | 20 × 20 |
| Skip link (at rest) | 1280/390px | 2 × 2, visually hidden until focused (standard sr-only pattern) |

The 20×20 checkbox is recorded exactly as measured; no conformance claim
is made about any of these numbers. Contrast ratios in `DESIGN.md` are
likewise computed from token math (author-side check), not browser
measurements and not a certification.

## Findings fixed during verification

- 320px overflow from the non-wrapping Overview/Endpoints headers and the
  fixed-width (`w-56`) ResourcePicker trigger → headers wrap, trigger is
  `max-w-full`.
- 100-char event IDs overflowed the detail heading → `min-w-0 break-all`.
- Fixture `user` row lacked `disabled_at`, tripping an error boundary on
  the Users tab → added `disabled_at: null`.
- `smoke.spec.ts` used the pre-Task-9 "Create admin" label and unscoped
  "New project/destination/source" buttons (strict-mode violations against
  empty-state duplicates) → updated labels and header/`first()` scoping.
- State-driven dialogs (no Radix trigger association) returned focus to
  `document.body` on Escape/Close → app-wide `onCloseAutoFocus`
  restoration in `components/ui/dialog.tsx` returns focus to the opener on
  every close path; the extended browser test proves the `New project`
  opener is focused after both Escape and the Close button. No dialog
  needed an exemption: every dialog renders the shared `DialogContent`, so
  all are covered.
- `redesign.spec.ts` named-screens entry mislabelled the `/login` screen
  as `setup` → relabelled `login` (`/setup` is captured separately).

## Known limitations (open follow-ups)

- Manual browser zoom to 200% (OS/browser zoom control, not CSS) has NOT
  been performed: the committed check is a 640-CSS-px viewport equivalence
  plus a programmatic CSS-zoom approximation, and no CDP-driven real zoom
  is available in this environment. Manual zoom verification with a
  content/functionality check is OPEN follow-up work.
- Screenshots attach to CI output only; none with real payloads are
  committed (`test-results/` and `playwright-report` gitignored).
