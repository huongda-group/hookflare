# Dashboard Project Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deployment card with a header project picker and keep project data scoped to the selected project without filtering shared management pages.

**Architecture:** Scoped routes use `project_id` in the URL as the source of truth and a remembered browser selection as fallback. Dashboard requests explicitly carry the resolved project; the Worker applies the scope before pagination, aggregation, reads, and writes without changing default behavior for existing unscoped API callers.

**Tech Stack:** React, TanStack Router/Query, Hono, Drizzle/D1, Zod, Vitest, MSW, and Playwright.

**Spec:** [Dashboard project switcher](../specs/2026-07-12-project-switcher-design.md)

## Global Constraints

- The picker is immediately left of the page title/breadcrumb on desktop and mobile. Remove both deployment cards. No “All projects” option on project views.
- Projects management is deployment-wide: listing, opening, and editing projects never depend on or change the header selection.
- Overview, Endpoints, Events, Failures, and project alert incidents follow the active project. Users, API tokens, account, backups, storage/retention, retry defaults, alert rules/channels, Archives, and Audit stay deployment-wide.
- Keep existing permissions, unscoped API behavior, first-project onboarding, and disabled-project history. No project membership feature, data migration, or changes to ingress, jobs, backup, or restore.
- Work in the current checkout. Preserve existing changes, including overlapping edits; do not use `git add -A`. At each runnable checkpoint below, commit only isolated feature hunks if commits are authorized; never stage unrelated changes.

## Review Focus

- Mixed-project bulk replay must not partially enqueue or audit a replay (Task 2).
- A late response or pending mutation from project A must not be rendered as or retargeted to project B (Tasks 5–6).
- Duplicate names and projects on later catalog pages must still be selectable by ID (Task 4).
- Invalid explicit URL scope and stale storage must never turn a project view into an unscoped fetch (Task 4).
- A deployment alert must not leak into project counts or be unreachable as a shared detail (Task 3).

---

### Task 1: Scope endpoint API detail and actions

**Files:** Modify `packages/shared/src/admin.ts`, `apps/gateway/src/admin/routes/sources.ts`, `apps/gateway/src/admin/routes/destinations.ts`. Extend `apps/gateway/test/admin/sources.test.ts`, `destinations.test.ts`, `destination-stats.test.ts`, `rotation.test.ts`, and `test-delivery.test.ts` in that test directory.

**Interfaces:** Export `projectScopeQuery` from shared as an object schema with optional `project_id` using the existing project ID schema; route handlers consume it with `readQuery`. Endpoint detail/action requests accept the same optional `?project_id=...` as the existing collection routes.

- [ ] Write `it("scopes endpoint collections and stats before paging")` with A/B rows: `expect(rows.every((row) => row.project_id === a.id)).toBe(true)` for collections; `expect(stats.map((row) => row.destination_id)).toEqual([aDestination.id])` for stats.
- [ ] Write parameterized `it("rejects scoped endpoint detail and mutations for another project")` for source GET/PATCH/rotate and destination GET/PATCH/rotate/pause/resume/test/test-history. Assert matched reads work, mismatches return `404` with `{ error: "not_found" }`, and mismatched writes leave endpoint state, tests, audit, and outbound calls unchanged. For both create routes assert a scope/body mismatch returns `400` and creates no records; keep current unscoped tests.
- [ ] Run `pnpm --filter gateway exec vitest run test/admin/sources.test.ts test/admin/destinations.test.ts test/admin/destination-stats.test.ts test/admin/rotation.test.ts test/admin/test-delivery.test.ts`; expect new mismatch tests to fail.
- [ ] Implement the exported schema. Match scope against endpoint ownership in existing reads and before side effects; creation uses the existing `project_id` body and rejects disagreement with query scope. Preserve source-to-destination project validation. Keep permission middleware before scope-dependent responses.
- [ ] Rerun the command; expect all cases to pass. Checkpoint: `feat: scope endpoint admin requests by project`.

### Task 2: Scope event and failure details, payloads, and replay

**Files:** Modify `apps/gateway/src/admin/routes/events.ts` and `apps/gateway/src/admin/routes/failures.ts`; extend `apps/gateway/test/admin/events.test.ts`, `failures.test.ts`, `payload.test.ts`, and `replay.test.ts` in that test directory.

**Interfaces:** Consume `projectScopeQuery`. `GET /events/:id`, `/events/:id/deliveries`, `/events/:id/payload`, `POST /events/:id/replay`, and `POST /failures/replay` accept optional `project_id`.

- [ ] Add `it("does not return an event, deliveries, or payload outside the project")`; an A request using B's ID returns `404`, and a mismatched payload request does not consult object storage. Assert A-only event/failure lists and next pages with interleaved A/B rows.
- [ ] Add `it("does not partially replay IDs spanning projects")`; post a valid failure from A plus a valid failure from B scoped to A. Assert `404`, unchanged delivery and audit counts, and no queue sends. Add equivalent `404` and no-side-effects assertions for single-event replay using B's event ID. Keep existing unscoped skip and replay tests.
- [ ] Run `pnpm --filter gateway exec vitest run test/admin/events.test.ts test/admin/failures.test.ts test/admin/payload.test.ts test/admin/replay.test.ts`; expect new detail/replay tests to fail.
- [ ] Apply project ownership using the parent event/delivery before payload reads or replay prechecks. In bulk replay, use the existing fetched delivery map to reject any found delivery in another project before processing any target. Preserve existing behavior for missing IDs that cannot be attributed to another project.
- [ ] Rerun the command; expect all cases to pass. Checkpoint: `feat: scope event detail and replay by project`.

### Task 3: Separate project and deployment alerts

**Files:** Modify `packages/shared/src/admin.ts`, `apps/gateway/src/admin/routes/overview.ts`, `apps/gateway/src/admin/routes/alerts.ts`; extend `apps/gateway/test/admin/overview.test.ts` and `alerts.test.ts`.

**Interfaces:** `overview?project_id=...&alert_scope=project` excludes null-project alerts; omission retains current counting behavior. `alerts?project_id=...` and `alerts/:id?project_id=...` match only the given project. `alerts?scope=deployment` and `alerts/:id?scope=deployment` match only null-project alerts. Reject `scope=deployment` plus `project_id`, or `alert_scope=project` without `project_id`, with `400`.

- [ ] Add `it("keeps deployment alerts out of the project incident count")` with open A, B, and deployment alerts. Assert scoped A count is `1` with `alert_scope=project` and `2` without it. Add `it("separates project and deployment incident lists and details")`: exact ID sets `[alertA.id]` and `[systemAlert.id]`; B and shared detail return `404` under A, shared detail returns `200` with deployment scope, and conflicting scopes return `400`.
- [ ] Run `pnpm --filter gateway exec vitest run test/admin/overview.test.ts test/admin/alerts.test.ts`; expect new scope assertions to fail.
- [ ] Add schema fields and validate combinations; apply project/NULL filters in Worker queries before pagination, count, or notification-history fetch. Keep legacy unscoped list/detail and Overview behavior.
- [ ] Rerun the command; expect all cases to pass. Checkpoint: `feat: separate project and deployment alerts`.

### Task 4: Resolve the selection and add the header picker

**Files:** Create `apps/dashboard/src/lib/project-selection.tsx` and `apps/dashboard/src/lib/project-selection.test.tsx`. Modify `apps/dashboard/src/components/AppShell.tsx`, `AppShell.test.tsx`, `apps/dashboard/src/lib/queries/projects.ts`, and `apps/dashboard/src/project-onboarding.test.tsx`. Add missing search fields to existing scoped route validators in `apps/dashboard/src/routes/{index,failures,endpoints/index,endpoints/destinations.$destinationId,endpoints/sources.$sourceId,events/index,events/$eventId,alerts/index,alerts/$alertId}.tsx`.

**Interfaces:** `useActiveProject(): { projectId: string | undefined; selectProject: (id: string) => void }` supplies the resolved ID and switch action. `useProjectCatalog()` returns a query whose data is the full ordered `Project[]`; key it under `qk.projects.all` so project mutations invalidate it. Use URL key `project_id`, storage key `hookflare.activeProjectId`, and accessible control name `Active project`.

- [ ] Add `it("resolves URL, remembered, and catalog default in that order")` covering URL B over stored A, stale storage falling back to the first project, explicit invalid URL showing a scope error with no scoped child fetch, storage access throwing, and selected disabled projects remaining valid.
- [ ] Add `it("offers both projects with the same name even across catalog pages")` using a second page fixture and distinct IDs; `it("places the project picker before the page breadcrumb without deployment cards")` using DOM order and absence of both old labels; and onboarding coverage for empty, load failure/retry, and first creation.
- [ ] Run `pnpm --filter dashboard exec vitest run src/lib/project-selection.test.tsx src/components/AppShell.test.tsx src/project-onboarding.test.tsx`; expect new tests to fail.
- [ ] Implement the catalog by following `next_cursor`; retain stable server order and append IDs to duplicate labels. In the provider, use valid explicit scope first, otherwise remembered ID then first project. Keep invalid explicit scope blocked until the user chooses a valid one; never issue unscoped requests as fallback. Guard storage reads/writes, and suppress the picker before onboarding completes.
- [ ] Implement the header control and provider in `AppShell`. Add optional `project_id` to scoped route search validators where absent and optional `scope: "deployment"` to alert detail. Only consume project URL scope on project views, not on Projects management or shared pages. Mount scoped views only with a resolved ID. Normalize missing project scope into scoped URLs with replace navigation; use push for explicit switches so Back restores the old selection. Use typed TanStack destinations: same collection or parent collection from a project detail under scope; preserve `range`, `tab`, status and time filters where supported, remove resource IDs/cursors, and key local project-view state by project ID. Keep shared routes and deployment alert details mounted with requests unchanged when choosing a project.
- [ ] Rerun the command; expect all cases to pass. Checkpoint: `feat: add dashboard project selection`.

### Task 5: Connect Endpoints and keep Projects management global

**Files:** Modify `apps/dashboard/src/pages/EndpointsPage.tsx`, `pages/endpoints/{SourcesTab,DestinationsTab,SourceDetailPage,DestinationDetailPage,SourceActions,DestinationActions}.tsx`, `pages/{ProjectsPage,ProjectDetailPage}.tsx`, `components/{SourceFormDialog,DestinationFormDialog,RotateSecretDialog,TestDeliveryDialog}.tsx`, `lib/api.ts`, `lib/queries/{endpoints,keys,resource-options}.ts`, and `routes/endpoints/{index,destinations.$destinationId,sources.$sourceId}.tsx`, all under `apps/dashboard/src/`. Extend existing tests in `pages/endpoints/` and `pages/{ProjectsPage,ProjectDetailPage}.test.tsx`; create `pages/EndpointsPage.test.tsx` for route-level assertions.

**Interfaces:** Consume `useActiveProject()` and Task 1's optional scope. Change `useSource(id: string, projectId: string)`, `useDestination(id: string, projectId: string)`, and `useDestinationTests(id: string, projectId: string)` to require scope; corresponding `qk` factories append project scope after the existing resource/ID prefix. Export `projectScopedPath(path: string, projectId: string): string` from `apps/dashboard/src/lib/api.ts` for scoped writes and raw requests, preserving any existing query parameters. Project management details continue to use the route's project ID.

- [ ] Add `it("lists and creates endpoints in the active project only")`. With A/B fixtures, assert the Endpoints tab and picker results contain only selected project rows, create POST has A in both query and body with no alternate project control, and late A data does not render after switching to B. Assert a pending A action retains A in the outgoing request and invalidates A's affected data even if selection is now B.
- [ ] Add `it("keeps the project catalog and management detail independent of header selection")`: Projects renders A and B with A active; open/edit B and keep header A; following a scoped link from B's detail opens that link as B.
- [ ] Run `pnpm --filter dashboard exec vitest run src/pages/EndpointsPage.test.tsx src/pages/endpoints src/pages/ProjectsPage.test.tsx src/pages/ProjectDetailPage.test.tsx src/lib/queries/resource-options.test.tsx`; expect new scoping assertions to fail.
- [ ] Route Endpoints list/stats, details/tests, related option lookups, creates, edits, rotations, pause/resume, and test requests through the selected project; remove the Endpoints page-level project filter. Use scoped cache keys and invalidate from mutation variables or the captured submission scope, not the latest selection. Preserve account/settings helper requests in `lib/queries/endpoints.ts` unchanged. If a shared dialog still has non-scoped consumers, pass explicit scope only from its project-scoped callers.
- [ ] Keep Projects collection and management detail queries unfiltered. For explicit links out of project detail, add the viewed project's ID to the scoped destination URL. Use the viewed project's ID for its existing summary, not the header selection.
- [ ] Rerun the command; expect all cases to pass. Checkpoint: `feat: connect endpoints to active project`.

### Task 6: Connect Overview, Events, Failures, and Alerts

**Files:** Modify `apps/dashboard/src/routes/{index,failures,events/index,events/$eventId,alerts/index,alerts/$alertId}.tsx`, `pages/{OverviewPage,EventsPage,EventDetailPage,FailuresPage,AlertsPage,AlertDetailPage}.tsx`, `components/{EventFilters,ReplayDialog}.tsx`, and `lib/queries/{overview,events,alerts,keys,invalidate-delivery-views}.ts` under `apps/dashboard/src/`. Extend the corresponding six `pages/*.test.tsx` files and `lib/queries/invalidate-delivery-views.test.tsx`. Trace page-local action/link helpers from these components and update those call sites if present.

**Interfaces:** Consume `useActiveProject()` and `projectScopedPath()`. `useEvent(id: string, projectId: string)` takes a required scope. Use an `AlertScope` union in `lib/queries/alerts.ts`: `{ project_id: string } | { scope: "deployment" }`, shared by list/detail query parameters and keys. Project and deployment alert links use distinct route search scope.

- [ ] Add `it("switches overview and investigations without leaking previous project state")`: fixture A/B overview and events/failures, then assert requests carry B, stale A rows never appear after switching, `destination_id`, `source_id`, cursor, and selected replay rows reset, and `from`/`to` or Overview `range` remain. Assert direct payload and replay requests carry the originating scope, and scoped links survive navigation and Back.
- [ ] Add `it("lists shared incidents separately without including them in project counts")`: expect A only in the project section and the null-project incident only in the deployment section. With B selected, a deployment alert link still loads with deployment scope; a project alert ID mismatched to B shows not found.
- [ ] Run `pnpm --filter dashboard exec vitest run src/pages/OverviewPage.test.tsx src/pages/EventsPage.test.tsx src/pages/EventDetailPage.test.tsx src/pages/FailuresPage.test.tsx src/pages/AlertsPage.test.tsx src/pages/AlertDetailPage.test.tsx src/lib/queries/invalidate-delivery-views.test.tsx`; expect new assertions to fail.
- [ ] Wire scoped Overview rollups, stats, recent events, and investigate links. Use `alert_scope=project` for project Overview, including the summary on project management detail. Remove page-level project selectors from Events, Failures, and Alerts where present; scope resource filters, event/delivery/payload reads, single and bulk replay, polling, and their invalidations. Preserve non-resource filter settings and keep a switch off a scoped detail on its parent collection.
- [ ] Render labeled project and deployment alert sections with independent queries and scoped links. Deployment alert details keep the account-level scope even when the project picker changes; switching on a project alert detail goes to Alerts.
- [ ] Rerun the command; expect all cases to pass. Checkpoint: `feat: scope project investigation views`.

### Task 7: Regression coverage and documentation

**Files:** Modify `apps/dashboard/e2e/{fixtures.ts,redesign.spec.ts,smoke.spec.ts}` and `apps/dashboard/src/pages/{ArchivesPage,AuditPage}.tsx`. Update `docs/{dashboard,projects,overview,destinations,sources,events,replay,alerts,archives,audit,contract}.md` as applicable.

- [ ] Add a fixture test `switches between projects without changing deployment pages` with distinct A/B labels, rows, counts, and filters. Assert picker order at desktop and mobile widths, no deployment cards, project URL persistence across reload and history, no A rows under B, both project records visible in Projects, and no `project_id` on settings, backup, archives, or audit requests. Assert clear deployment-wide copy on Archives and Audit.
- [ ] Add a real Worker/D1 smoke assertion for a second seeded project: after creating/showing endpoints in both, switch and verify each Endpoints list only shows its own resources. Keep the first-project flow and existing smoke assertions. Run `pnpm build` before the fixture and smoke suites; run `pnpm --filter dashboard e2e redesign.spec.ts` and `pnpm --filter dashboard e2e smoke.spec.ts` in separate processes. If the new fixture test fails only on missing copy, add the deployment labels; if a scope assertion fails, fix it in the owning task's code.
- [ ] Update the feature pages to document header selection, the Projects/Endpoints distinction, scoped API and legacy defaults, shared operations, and alert count rules. Check documentation links and record any browser/environment limitation without claiming live staging verification.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, and fresh `pnpm build`. Expect successful exits; rerun both separate E2E commands against the fresh build. Run `git diff --check` on the feature changes. If an existing checkout failure prevents a green check, record the failing command and actual output separately from the feature results. Checkpoint: `test: verify dashboard project switching end to end`.
