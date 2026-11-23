# Dashboard Action Toasts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline implementation, or superpowers:subagent-driven-development if delegation is requested. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show one success or failure toast for every dashboard API write.

**Architecture:** Report write outcomes in `apiRaw`, share one Sonner host above both route layouts, and leave permission refresh in the query client without a second mutation toast.

**Tech Stack:** React, TanStack Router/Query, Sonner, Vitest, and MSW.

**Spec:** [Dashboard action toasts design](../specs/2026-11-21-dashboard-action-toasts-design.md)

## Global Constraints

- Cover dashboard `POST`, `PUT`, `DELETE`, and `PATCH`, including authentication pages. No new `GET` feedback, gateway changes, or dependencies.
- Preserve inline form errors, session handling, permission refresh, and clipboard notifications. Do not include sensitive values or server bodies in toast text.
- Work in the current checkout and preserve existing changes.

## Review Focus

- A `204` write confirms success without trying to parse an empty response.
- A `202` write confirms acceptance, not that the background work is finished.
- A `403` write under TanStack emits one toast and still refreshes `/me`.
- Network failures emit one safe toast and still reject with `network_error`.
- Failed login shows both toast and inline error; successful login preserves the toast across redirect.

### Task 1: Centralize and display write outcomes

**Files:** `apps/dashboard/src/lib/api.ts`, `apps/dashboard/src/lib/api.test.ts` (extend or create), `apps/dashboard/src/router.ts`, `apps/dashboard/src/routes/__root.tsx`, `apps/dashboard/src/components/AppShell.tsx`, the existing login tests, and `docs/dashboard.md`.

**Interfaces:** Preserve `apiRaw(path: string, init?: RequestInit): Promise<Response>` and `ApiError`. Expose `api.put<T>(path: string, body?: unknown): Promise<T>` alongside existing JSON helpers; raw requests can continue to use `apiRaw` for no-content endpoints.

- [ ] Add a parameterized API test: each write method produces one `toast.success("Action completed.")` on `204`, one `toast.error("Action failed.")` on a generic HTTP failure, and preserves the return/rejection contract. A `GET` adds neither toast.
- [ ] Add cases for `202` (`"Request accepted."`), network rejection (`"Network error. Please try again."`, `ApiError.code === "network_error"`), and forbidden mutation (`"You do not have permission for that action."` once, `/me` invalidated). Test the real login route for visible failure plus existing inline validation and persistent success after navigation.
- [ ] Run the focused API and login tests to verify they fail on the missing feedback before changing behavior.
- [ ] Classify the case-normalized request method in `apiRaw`. Emit a single outcome toast without parsing successful response bodies there. Preserve current error handling and session redirects. Keep the `403` error message and `/me` refresh separated so a mutation does not announce the failure twice.
- [ ] Move the existing Sonner host from `AppShell` to `RootComponent` as a sibling of the selected route layout, keeping it mounted across route changes.
- [ ] Update `docs/dashboard.md` with the shared feedback convention, including that asynchronous requests are acknowledged rather than declared finished.
- [ ] Run `pnpm --filter dashboard test`, `pnpm --filter dashboard typecheck`, and `git diff --check`. Review changes against the spec and verify the work does not alter unrelated existing edits.
