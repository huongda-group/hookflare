# Overview and statistics

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

Overview summarizes webhook intake, delivery outcomes, active backlog, and alerts. Historical series use hourly rollups refreshed every five minutes; live counts are read separately. These values describe different time bases and must not be presented as realtime equivalents.

## Design and interaction

UI `/` uses GET `/api/admin/v1/overview`; destination statistics use GET `/api/admin/v1/destinations/stats`. Read permission is `events.read`.

The Needs attention section comes before Delivery performance: current open-alert count and destination failures are separate signals. Destination failures are **historical in the selected period**, never unresolved-current counts; Investigate links carry destination, project (when scoped), and `from`/`to`. An empty snapshot makes no whole-system health claim.

Reporting groups received, completed, success rate, terminal failures, a data-driven traffic chart, and a separate current-state strip. `pending + queued + in_flight` is the displayed Pending value. Range controls update the query and chart; daily grouping outside 24h uses local day labels. `generated_at` is API response generation time, not rollup execution time. Recent events show source → latest destination, latest-delivery status, and received time together on narrow screens, with exact ID fallback when names cannot be resolved. Project detail reuses the Overview content; loading, retry, and no-activity states remain distinct.

## Ideas, boundaries, and open work

Traffic tiers in historical design documents are capacity targets. No live latency or throughput promise follows from a chart or fixture screenshot.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/admin/routes/overview.ts](../apps/gateway/src/admin/routes/overview.ts)
- [apps/gateway/src/core/db/stats.ts](../apps/gateway/src/core/db/stats.ts)
- [apps/gateway/src/jobs/rollup.ts](../apps/gateway/src/jobs/rollup.ts)
- [apps/dashboard/src/pages/OverviewPage.tsx](../apps/dashboard/src/pages/OverviewPage.tsx)
- [apps/gateway/test/admin/overview.test.ts](../apps/gateway/test/admin/overview.test.ts)
