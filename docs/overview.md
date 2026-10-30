# Overview and statistics

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

Overview summarizes webhook intake, delivery outcomes, active backlog, and alerts. Historical series use hourly rollups refreshed every five minutes; live counts are read separately. These values describe different time bases and must not be presented as realtime equivalents.

## Design and interaction

UI `/` uses GET `/api/admin/v1/overview`; destination statistics use GET `/api/admin/v1/destinations/stats`. Read permission is `events.read`.

Use prominent key values, explicit time range, chart labels, and links into filtered investigation. Distinguish zero from no data or a failed fetch. The rollup job recomputes bounded windows; do not infer historical totals from the current active backlog.

## Ideas, boundaries, and open work

Traffic tiers in historical design documents are capacity targets. No live latency or throughput promise follows from a chart or fixture screenshot.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/admin/routes/overview.ts](../apps/gateway/src/admin/routes/overview.ts)
- [apps/gateway/src/core/db/stats.ts](../apps/gateway/src/core/db/stats.ts)
- [apps/gateway/src/jobs/rollup.ts](../apps/gateway/src/jobs/rollup.ts)
- [apps/dashboard/src/pages/OverviewPage.tsx](../apps/dashboard/src/pages/OverviewPage.tsx)
- [apps/gateway/test/admin/overview.test.ts](../apps/gateway/test/admin/overview.test.ts)

