# Overview and statistics

[Documentation index](README.md)

## Business rules and current behavior

Overview summarizes webhook intake, delivery outcomes, active backlog, and alerts. Historical counts come from the hourly `stats_hourly` rollup; live backlog and open-alert counts are read directly from `deliveries` and `alerts` on every request. These values describe different time bases and must not be presented as realtime equivalents.

The rollup runs every five minutes (see [architecture](architecture.md)). Each run rebuilds the current hour and the two before it from source rows: one D1 batch deletes the hour and re-inserts it, so readers never see a half-built hour and counts are never incremented. A backfill cursor (`rollup.backfill_before` setting) also rebuilds up to six older hours per run, back to the oldest stored event, and then records `done`. A corrupt cursor restarts the backfill; a failed hour stops it, so no hour is skipped. Rows are keyed by hour, project, source, and destination. Received counts use the event's `received_at` and the destination of its initial delivery; `delivered`, `failed_final`, and `dead` count by delivery `completed_at`; attempts count by attempt `started_at`.

Ranges are `24h` (default), `7d`, and `30d`, each a whole number of hours ending at the end of the current hour. Success rate is `delivered / (delivered + failed_final + dead)` and is `null` when nothing completed. Failing destinations are the five destinations with the most `failed_final + dead` deliveries in the range. Live counts cover `pending`, `queued`, `in_flight`, `retrying`, and `paused` deliveries.

## Design and interaction

UI `/` uses GET `/api/admin/v1/overview` (`range`, `project_id`, `alert_scope`); destination statistics use GET `/api/admin/v1/destinations/stats`. Read permission is `events.read`.

Dashboard totals, recent events, and incident counts are for the active project. Open-alert counting in the API follows these rules: without `project_id`, every open incident counts; with `project_id` alone, the project's incidents and deployment incidents (no project) count; `alert_scope=project` counts only the project's incidents and requires `project_id`, otherwise the request returns `400`. The dashboard always sends `alert_scope=project` with `project_id`.

The Needs attention section comes before Delivery performance: current open-alert count and destination failures are separate signals. Destination failures are **historical in the selected period**, never unresolved-current counts; Investigate links carry destination, project (when scoped), and `from`/`to`. An empty snapshot makes no whole-system health claim.

Reporting groups received, completed, success rate, terminal failures, a data-driven traffic chart, and a separate current-state strip. `pending + queued + in_flight` is the displayed Pending value. Range controls update the query and chart; daily grouping outside 24h uses local day labels. `generated_at` is API response generation time, not rollup execution time. Recent events show source → latest destination, latest-delivery status, and received time together on narrow screens, with exact ID fallback when names cannot be resolved. Project detail reuses the Overview content; loading, retry, and no-activity states remain distinct.

## Ideas, boundaries, and open work

The rollup and recent-event views are not uptime probes or capacity measurements. See [operations](operations.md) for monitoring and benchmark evidence.

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/admin/routes/overview.ts](../apps/gateway/src/admin/routes/overview.ts)
- [apps/gateway/src/core/db/stats.ts](../apps/gateway/src/core/db/stats.ts)
- [apps/gateway/src/jobs/rollup.ts](../apps/gateway/src/jobs/rollup.ts)
- [packages/shared/src/admin.ts](../packages/shared/src/admin.ts) (`overviewQuery`, `RANGE_HOURS`, `LIVE_STATUSES`)
- [apps/dashboard/src/pages/OverviewPage.tsx](../apps/dashboard/src/pages/OverviewPage.tsx)
- [apps/dashboard/src/components/OverviewAttention.tsx](../apps/dashboard/src/components/OverviewAttention.tsx)
- [apps/dashboard/tests/pages/OverviewPage.test.tsx](../apps/dashboard/tests/pages/OverviewPage.test.tsx)
- [apps/gateway/tests/admin/overview.test.ts](../apps/gateway/tests/admin/overview.test.ts)
- [apps/gateway/tests/admin/destination-stats.test.ts](../apps/gateway/tests/admin/destination-stats.test.ts)
- [apps/gateway/tests/jobs/rollup.test.ts](../apps/gateway/tests/jobs/rollup.test.ts)
- [apps/gateway/tests/jobs/rollup-backfill.test.ts](../apps/gateway/tests/jobs/rollup-backfill.test.ts)
