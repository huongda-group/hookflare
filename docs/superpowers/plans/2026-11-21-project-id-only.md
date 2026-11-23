# Project ID Only Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan in the current checkout, or superpowers:subagent-driven-development if the user requests delegation. Steps use checkbox syntax for tracking.

**Goal:** Remove the project slug from the live database and application while preserving project IDs.

**Architecture:** The generated project ID remains the primary key and API route parameter. Append a Drizzle migration and update the shared contract and all first-party consumers together.

**Tech Stack:** TypeScript, Zod, Hono, Drizzle, Cloudflare D1, React, Vitest.

**Spec:** [Project ID as the only identifier](../specs/2026-11-21-project-id-only-design.md)

## Global Constraints

- Preserve existing IDs, project status, timestamps, foreign keys, and historical records.
- Do not modify applied migrations or their snapshots. Generate the new migration with `pnpm db:generate`.
- Work in the current checkout and preserve existing user changes.

## Review Focus

- Existing D1 data: test the upgrade with a project and dependent rows already present.
- Duplicate display names: test that each create succeeds and returns a distinct ID.
- Resource links: test that project list links address the generated ID.
- First-project setup: keep the existing dashboard and gateway onboarding tests passing with name-only creation.
- Smoke runs: test reuse by name from a later page and propagation of the returned ID.

## Task 1: Database and Admin API

**Files:** `apps/gateway/src/core/db/schema.ts`, `apps/gateway/migrations/`, `packages/shared/src/admin.ts`, `apps/gateway/src/admin/routes/projects.ts`, `apps/gateway/test/migrations.test.ts`, `apps/gateway/test/admin/projects.test.ts`, `packages/shared/test/admin.test.ts`, and gateway seed helpers and fixtures.

**Interface:** `POST /api/admin/v1/projects` takes `{ name, reason? }` and returns `{ id, name, status, created_at, updated_at }`. `GET` and `PATCH` continue using `:id`.

- [ ] In the Admin API tests, create two projects with `{ name: "Shop" }`, expect two `201`s and distinct `prj_` IDs, and assert create/get/list representations omit the old property. Verify invalid names still return `400`.
- [ ] In the existing legacy migration test, assert the exact final `projects` columns are `id`, `name`, `status`, `created_at`, and `updated_at`. Verify the existing `prj_ll` and its dependent rows retain their IDs, and `PRAGMA foreign_key_check` returns no rows. Add linked source/event fixtures to cover their references too.
- [ ] Run `pnpm --filter gateway exec vitest run test/admin/projects.test.ts test/migrations.test.ts`; confirm the new behavior fails against the old implementation.
- [ ] Remove the column and uniqueness declaration from `projects`, then run `pnpm db:generate`. Inspect the generated SQL: it should drop the slug index before the column and not drop or recreate the referenced table.
- [ ] Remove the field from `createProjectRequest`, `Project`, and `toProject`. Remove duplicate-slug-specific handling and fix test inserts and fixtures. Keep old column references where they intentionally seed or assert the legacy schema.
- [ ] Rerun the targeted gateway tests and shared contract tests. Run the existing gateway onboarding tests with name-only project creation.

## Task 2: Dashboard, tooling, and documentation

**Files:** `apps/dashboard/src/components/ProjectFormDialog.tsx`, `apps/dashboard/src/pages/ProjectsPage.tsx`, `apps/dashboard/src/pages/ProjectsPage.test.tsx`, dashboard fixtures and E2E tests, `scripts/lib/smoke.mjs`, `scripts/test/smoke.test.mjs`, `tools/bench/src/run.ts`, `README.md`, and `docs/projects.md`.

**Interface:** The dashboard submits the Task 1 request and uses `Project.id` for links. Smoke looks for the configured project name and uses the returned ID for dependent resources.

- [ ] Update tests for the Projects page to assert name-only submission and ID-based row links. Update smoke fixtures to exercise name matching on a later page and verify that dependent requests use the returned project ID.
- [ ] Run the targeted Projects page and smoke tests; confirm the changed expectations fail before the corresponding code changes.
- [ ] Remove the slug input and column, show the project ID in the list, and update dashboard fixtures and E2E tests. Keep edit and onboarding flows working.
- [ ] Update smoke and bench requests to send only the project name. Update project docs and the README quick start. Leave unrelated platform types and generic examples untouched.
- [ ] Run `pnpm test`, `pnpm typecheck`, and `pnpm lint`. Check migration drift with the repository's migration checker. Search remaining project slug references and verify each is intentional migration history or a regression test.
