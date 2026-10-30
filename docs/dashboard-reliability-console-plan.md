# Reliability Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution or superpowers:subagent-driven-development for task-by-task delegated execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved Reliability Console shell, Overview and Event detail against the existing live application interfaces.

**Architecture:** Reuse current routing, TanStack Query caches, RBAC, Radix controls and replay/payload components. Restyle the shell and decompose the two pages around operational summaries, real reporting and a selected-attempt inspector. Presentation changes consume existing API contracts and preserve query behavior.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind 4, TanStack Router/Query, Radix, lucide-react, Recharts, Vitest/Testing Library, Playwright.

**Spec:** [dashboard-reliability-console.md](dashboard-reliability-console.md), including the approved prototype path.

## Global Constraints

- Light canvas `#F7F8FA`, white content surfaces, sidebar `#F1F3F7`, foreground `#202733`, muted foreground `#667080`, border `#E3E7ED`, primary action `#245BDB`.
- Page title approximately 26px desktop / 24px narrow; main UI text 13–14px; supporting text 12px; compact metadata at least 11px. Preserve accessible zoom and 44px coarse-pointer hit areas.
- No new framework, remote font, backend endpoint or schema migration. Use existing English product terminology and permission gates.
- Historical destination failures must never be labeled current/unresolved without a matching API contract. `generated_at` is API response time, not rollup execution time.
- Response inspector displays `response_snippet`, not a fabricated full response. Payload remains explicit and permission-gated. Replay creates another delivery.
- Existing uncommitted `.gitignore` and `docs/runbook.md` work is outside this plan. Preserve it. Do not automatically commit unrelated files.
- Prototype controls/data are illustrative. Copy the approved HTML into an isolated worktree reference area if execution uses a worktree; do not copy its mock business data into shipping code.

## Review Focus

1. Repeated attempt numbers across replay deliveries: selection must use delivery/attempt IDs; pin in Task 3.
2. No deliveries, null HTTP, absent snippets and HTML-like responses: honest empty/text-only presentation; pin in Task 3.
3. Historical failures and changing project/range: maintain scope and avoid current-health claims or old-project responses; pin in Task 2.
4. Payload permission, missing payload and navigation/polling: no unsolicited fetch or cross-event selected response; pin in Task 3.
5. Long resource names/IDs and shared-shell regressions at 390/1024px: visible status/actions, keyboard navigation and preserved account controls; pin in Tasks 1 and 4.

## Task 1: Shared shell and visual foundation

**Files:** Modify `apps/dashboard/src/index.css`, `components/AppShell.tsx`, `components/AppNavigation.tsx`, `components/AccountMenu.tsx`, `components/PageHeader.tsx`, `components/StatusBadge.tsx` under `apps/dashboard/src`. Existing checks: `components/AppShell.test.tsx`, `components/presentation.test.tsx` and `e2e/redesign.spec.ts`.

**Interfaces:** Keep `AppShell()`, `AppNavigation({ onNavigate? })`, `PageHeader({ title, description?, actions?, children?, className? })`, `StatusBadge({ status })` and existing account actions compatible. Preserve the main-content landmark and skip link.

- [ ] Record a clean baseline with `pnpm --filter dashboard test`; identify pre-existing failures before editing.
- [ ] Update semantic tokens and shared component spacing to the approved reference. Add only the semantic tokens required for selected surfaces, chart series and foreground states; verify contrast rather than relying on old token comments.
- [ ] Implement the branded sidebar, navigation grouping, top bar and authenticated account treatment using existing routes and lucide icons. Retain mobile drawer, focus restoration, logout, change-password and API-token controls. Keep the current 1024px desktop-sidebar threshold.
- [ ] Preserve existing shell/RBAC assertions; add a browser assertion in Task 4 for long account names and the 1024px boundary. Do not add tests that merely mirror CSS values.
- [ ] Run `pnpm --filter dashboard exec vitest run src/components/AppShell.test.tsx src/components/presentation.test.tsx`. Expected: all pass. Record the diff as one reviewable shell unit; commit only if the user requests commits.

## Task 2: Incident-first Overview with real reporting

**Files:** Modify `apps/dashboard/src/pages/OverviewPage.tsx`, `components/charts/TrendChart.tsx`; create `components/OverviewAttention.tsx` and `components/RecentEventsTable.tsx` under `apps/dashboard/src`. Tests: `pages/OverviewPage.test.tsx`, `pages/ProjectDetailPage.test.tsx`.

**Interfaces:** Preserve `OverviewContent({ projectId?: string, range: StatsRange, onRangeChange: (r: StatsRange) => void })`. New `OverviewAttention({ overview: Overview, projectId?: string })` consumes existing historical failures and current alert count. New `RecentEventsTable({ events: EventSummary[] })` renders rows/cards with real event links and existing name-cache fallback. Preserve `TrendChart({ points: TrendPoint[], range: StatsRange })`.

- [ ] Change the existing section-order test to assert attention precedes reporting and recent events. Add assertions that historical counts are labeled for the selected period and destination links include `project_id`, `destination_id`, `from` and `to`; no “unresolved” claim is produced from rollups. Run `pnpm --filter dashboard exec vitest run src/pages/OverviewPage.test.tsx` and confirm the intended new assertions fail.
- [ ] Implement attention above the unified reporting surface. Render open alerts independently of whether historical destinations failed. Keep the existing query scope and error/empty handling.
- [ ] Group four metrics, real trend chart and current-state strip as the approved panel. Preserve null rate as an em dash, thousands separators, pending aggregation, proper range-dependent chart data, accessible chart summary/table and honest freshness labels. Refresh should refetch the current overview and recent-event keys, with a pending state.
- [ ] Replace the recent-events list with the desktop table/narrow rows; show source → destination, latest status and timestamp without duplicating IDs. Missing latest delivery remains an explicit no-delivery state. Warm existing resource-option caches once per kind/project, not per row; preserve exact-ID fallback for unloaded pages.
- [ ] Keep and run existing tests for null rates, slow old-project responses, query parameters, no-data charts and `generated_at`. Run `pnpm --filter dashboard exec vitest run src/pages/OverviewPage.test.tsx src/pages/ProjectDetailPage.test.tsx`. Expected: all pass, including the new ordering/scope assertions.

## Task 3: Contextual delivery timeline and response inspector

**Files:** Modify `apps/dashboard/src/pages/EventDetailPage.tsx`, `components/DeliveryTimeline.tsx`; create `components/EventInspector.tsx` and `components/EventDeliveryContext.tsx` under `apps/dashboard/src`. Reuse `ResourceLabel.tsx`, `PayloadPanel.tsx`, `ReplayDialog.tsx`, `JsonViewer.tsx`, `lib/queries/events.ts`, `lib/queries/endpoints.ts`. Tests: `pages/EventDetailPage.test.tsx`, `components/DeliveryTimeline.test.tsx`, `components/PayloadPanel.test.tsx`; create `components/EventInspector.test.tsx`.

**Interfaces:**
- Keep `EventDetailPage({ eventId: string })` as orchestration owner.
- `EventInspector({ event: WebhookEvent, attempt: DeliveryAttempt | null, canReadPayload: boolean, onPayloadMissing: () => void })` owns Response/Request headers/Payload tabs and explicit payload mounting.
- `EventDeliveryContext({ event: WebhookEvent, delivery: Delivery | null })` decorates the source and selected destination using existing bounded detail queries in child components mounted only when IDs exist. Failed enrichment falls back to IDs.
- Extend `DeliveryTimeline` with `selectedAttemptId?: string` and `onSelectAttempt?: (attempt: DeliveryAttempt) => void`; retain `delivery`, `receivedAt`, `defaultOpen`. Parent closure supplies the delivery ID. With the callback, selecting a row drives the inspector; without it, preserve existing inline disclosure compatibility.

- [ ] Add tests for selecting attempt 1 from two deliveries whose attempt numbers overlap; inspector must show the selected delivery's unique snippet. Assert valid selection survives refreshed objects, event ID changes reset selection and absent selected IDs fall back to newest available delivery/attempt. Run targeted tests and confirm failures reflect the missing interaction.
- [ ] Add inspector tests for null HTTP plus `error_kind`, absent snippet, plain-text snippets and an HTML-like `<script>` string. Assert text rendering and explicit unavailable text; no HTML execution or fictional response headers.
- [ ] Implement selected-delivery/attempt state by IDs, deriving objects from the current query result. Defaults: newest delivery, its highest `attempt_no`; null if absent. Keep all delivery histories accessible and original/replay receipt/creation semantics intact.
- [ ] Build the approved header, relationship strip, status summary, timeline and two-column inspector. Derive terminal/retrying/paused descriptions from actual state and timing. Omit historical policy values that the delivery DTO does not provide. Bound long snippets and code scrolling.
- [ ] Reuse payload/replay behavior. Keep tests for viewer restrictions, reveal-only fetch, binary downloads, HTML-as-text payload, confirmed missing payload disabling Replay, transient payload retry and newest-first histories. After replay, refetch history; never translate created/awaiting enqueue into delivered success.
- [ ] Run `pnpm --filter dashboard exec vitest run src/pages/EventDetailPage.test.tsx src/components/DeliveryTimeline.test.tsx src/components/EventInspector.test.tsx src/components/PayloadPanel.test.tsx src/components/dialogs.test.tsx`. Expected: all pass. Adjust old labels/selectors only when the approved interaction genuinely changes; preserve behavioral assertions.

## Task 4: Browser acceptance and durable design documentation

**Files:** Extend `apps/dashboard/e2e/fixtures.ts` and `apps/dashboard/e2e/redesign.spec.ts`; update `docs/dashboard.md`, `docs/overview.md`, `docs/events.md`, `docs/README.md`, `CHANGELOG.md`. Record implemented token/component decisions in the dashboard design documentation; any Impeccable sidecar must describe the built result.

**Interfaces:** Keep existing `installApp(page)` fixture behavior backward-compatible; add opt-in scenarios for multiple deliveries, zero attempts, long names/IDs and response snippets. Preserve route interception of all admin requests. Live `smoke.spec.ts` remains a separate process from fixture tests.

- [ ] Add browser assertions for attention before reporting; selected-attempt response; explicit payload reveal; replay modal keyboard focus/Escape; narrow-screen status visibility; and 390/1024/1440px page containment with long IDs. Include viewer permission checks and preserve existing navigation/account regression tests.
- [ ] Run `pnpm --filter dashboard test`, `pnpm typecheck`, `pnpm lint` and `pnpm build`. Expected: all pass; report any unrelated baseline failures explicitly. Build before E2E because Wrangler serves dashboard `dist`.
- [ ] Run `pnpm --filter dashboard e2e redesign.spec.ts`; then separately `pnpm --filter dashboard e2e smoke.spec.ts`. Expected: both processes pass. Do not merge fixture and live suites or reuse an already-running application server on their dedicated port.
- [ ] Capture Overview and Event detail at 1440px and 390px in one browser batch, include a 1024px shell check, and compare against the approved prototype. Use production-shaped fixtures with clear labels. Fix findings in one batch and confirm in at most one further capture round.
- [ ] Run the Impeccable detector once on changed markup/component targets, interpret contextual false positives, and review the final diff/visual evidence. Request one independent final review if using native execution; follow task reviews if delegated execution was chosen. Fix only evidenced issues.
- [ ] Update feature documentation, implemented design tokens and Unreleased changelog with actual behavior. Link the approved direction and plan from `docs/README.md`. Record browser scope, tests and remaining limitations without claiming accessibility certification.

## Self-review

Spec coverage: visual foundation → Task 1; attention/reporting/recent events → Task 2; delivery context/selection/inspector/recovery → Task 3; responsive, keyboard, cross-page regression and docs → Task 4. All five Review Focus cases have owning tests. Shared public props remain compatible, and new components consume existing exported API types. The plan deliberately uses existing contracts rather than promoting synthetic mockup claims into backend requirements.

Execution method and implementation are pending user confirmation. Native execution is recommended because these four units share shell/tokens and event selection state; one implementer can keep those interfaces coherent, followed by an independent final review.
