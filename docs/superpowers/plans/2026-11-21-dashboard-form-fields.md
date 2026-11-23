# Dashboard Form Fields Implementation Plan

> **For agentic workers:** Execute the checklist in the existing checkout and track it in OpenCode Todo.

**Goal:** Give stacked form fields a uniform 8px label-to-control gap.

**Architecture:** Add `FormField` in `apps/dashboard/src/components/FormField.tsx`. It accepts `htmlFor`, `label`, `children`, and optional `className`/`labelClassName`; it renders the existing `Label` and lays out the caller's control and supporting content. Existing controls retain their refs and props.

**Tech Stack:** React, Tailwind, Playwright.

**Spec:** [Dashboard form fields](../specs/2026-11-21-dashboard-form-fields-design.md).

## Global Constraints

Keep inline checkbox/switch rows, auth keyboard order, accessible labels, and validation unchanged. No new dependencies.

## Review Focus

Verify native date/time controls, textarea fields, picker triggers, visually stacked auth fields, and responsive filter wrapping.

## Tasks

- [x] Add a Playwright regression to `apps/dashboard/e2e/redesign.spec.ts` measuring gaps on Events and Retry Defaults at 390px and 1440px; confirm it fails against the existing UI.
- [x] Add `FormField`, then migrate stacked labels from dashboard filters, settings, forms, dialogs, and auth. Set matching trigger IDs for visually labeled resource pickers. Keep Setup's two password inputs before their visibility toggles in DOM order.
- [x] Record the convention in `docs/dashboard.md`. Run the browser regression and fixture suite, repository tests, dashboard typecheck, and a diff review.

## Review record

- Fixed mobile Add user control overlap; the new 390px test failed before wrapping the row and passed afterward.
- Dashboard verification: 414 unit tests, 24 Chromium fixture tests, typecheck, and build passed. The browser suite logged an Archives fixture error outside this change.
- Deferred: Setup toggle positioning is verified on current Chromium, not on browsers without CSS subgrid.
