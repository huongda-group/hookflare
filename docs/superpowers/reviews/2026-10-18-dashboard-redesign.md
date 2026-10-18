# Review: dashboard redesign (2026-10-18)

Verification-first review of the light dashboard redesign (Tasks 1–13).
Scope: UI/UX and its automated proof, not the Worker pipeline.

## What was verified

- Unit: 1338 tests green across the monorepo (dashboard 362, gateway 836,
  shared 58, bench 70, sink 12).
- Browser, fixture suite (`apps/dashboard/e2e/redesign.spec.ts`, 12 tests):
  no page-level horizontal overflow at 1440/1280/768/390/320px and 640px
  (≈200% zoom); setup/login states incl. inline 401; keyboard-operated bulk
  replay that reports "Awaiting enqueue" and never claims "Delivered";
  reason-confirmed pause via the Actions menu; viewer matrix (no Audit UI,
  no protected audit fetch, Settings degrades to Retry) plus 403 feedback
  and downgrade; drawer/dialog Escape behaviour; explicit payload reveal
  with request counting; stress dataset (100-char IDs, 200+-char URLs,
  duplicate names) at 390/320px; empty/error/one-time-secret states;
  10 named screens with headings and landmarks.
- Browser, live suite (`e2e/smoke.spec.ts`): real Worker + fresh D1,
  project → destination → source from the UI, `whsec_` reveal, DLQ exit
  criteria. Kept separate/sequential from the fixture suite.
- Red demonstrations: 3 deliberately failing fixture tests (wrong heading,
  inverted overflow assertion, unposted replay assertion) all failed as
  designed, then were deleted; the passing suite is the committed spec.
- `tsc --noEmit`, build, and biome on all touched files are clean. Repo-wide
  `biome check .` fails identically at HEAD (pre-existing format/lint
  drift, e.g. CursorTable a11y, EventFilters deps); this task adds zero new
  diagnostics.

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

## Known limitations

- State-driven dialogs (no Radix trigger association) return focus to the
  document body on Escape/Close, not to the opener; the opener stays
  keyboard-reachable and the nav drawer restores its trigger. No focus trap
  or focus loss was observed. Restoring opener focus app-wide is follow-up
  work, not part of this task.
- Screenshots attach to CI output only; none with real payloads are
  committed (`test-results/`, `playwright-report` gitignored).
