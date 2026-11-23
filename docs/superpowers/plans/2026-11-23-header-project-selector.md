# Header Project Selector Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for native execution or superpowers:subagent-driven-development if delegation is requested. Track steps in the native Todo list.

**Goal:** Make the header project selector match the dashboard without changing project selection behavior.

**Architecture:** Replace the native control in `AppShell` with the shared Select and keep the existing controlled value and callback. Adapt tests to interact with the public combobox and its portal-rendered options.

**Tech Stack:** React, Radix Select, Tailwind, Vitest, Playwright.

**Spec:** [Header project selector](../specs/2026-11-23-header-project-selector-design.md)

## Global Constraints

- Keep the selector before the breadcrumb and retain the accessible name “Active project.”
- No new dependency, routing or persistence changes, or changes to other Select consumers.
- Preserve existing working-tree changes.

## Review Focus

- A long project label must not overlap the breadcrumb on a narrow viewport.
- The keyboard can open and dismiss the project list, restoring focus.
- Duplicate names remain distinguishable and disabled projects remain selectable.
- An invalid explicit project still shows the prompt and accepts a replacement.
- Switching projects still updates scoped data and survives reload and browser back.

### Task 1: Replace the header control

**Files:** `apps/dashboard/src/components/AppShell.tsx`, `apps/dashboard/src/lib/project-selection.test.tsx`, other dashboard specs that target `Active project`, `apps/dashboard/e2e/redesign.spec.ts`, `apps/dashboard/e2e/smoke.spec.ts`, `docs/dashboard.md`.

**Interfaces:** Use `projectId ?? ""` as the Select value and the existing `selectProject` callback as `onValueChange`. Expose the existing `Active project` combobox and project options by their display labels.

- [ ] Add a fixture browser test at 320px with a long project name: assert that the combobox stays before the breadcrumb, opens with the keyboard, displays the selected option and full label, and restores trigger focus on Escape.
- [ ] Run that test against the current header and confirm it fails when trying to open the page-rendered listbox.
- [ ] Replace only the header control using `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, and `SelectItem`. Use a decorative project icon, a compact responsive trigger, and a viewport-bounded popover. Preserve option labels and show “Choose a project” when no project is selected.
- [ ] Update native-select-specific assertions and interactions in the existing tests to use visible trigger labels and listbox options. Retain duplicate-name, disabled project, invalid URL recovery, scoped data, reload, and back-navigation assertions. Document the new header appearance in `docs/dashboard.md`.
- [ ] Run `pnpm --filter dashboard test`, `pnpm --filter dashboard typecheck`, and the fixture Playwright tests in `redesign.spec.ts`. Verify the relevant live smoke flow separately if the local Worker is available. Inspect the diff without staging unrelated work.
