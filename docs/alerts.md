# Alerts and notification channels

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

Alert rules track operational incidents such as consecutive destination failures, newly dead deliveries, stuck pending work, D1 storage pressure, stuck archives, and stale backups. Incidents can open, resolve, and produce notifications with cooldown. Notification delivery is tracked separately from incident state.

Admins configure rules and Discord, Slack, or Telegram channels. Channel configuration is encrypted; secret values are not returned through read endpoints. Outbound channel requests are restricted to the supported provider endpoints.

## Design and interaction

UI `/alerts` and `/alerts/:alertId` show incident metadata and notification history. Settings → Alerts edits rules and channels. API groups are `/api/admin/v1/alerts` and `/api/admin/v1/alert-channels`; channel operations include create/update/delete and test.

A channel test result must not imply the incident rules or external monitoring are all healthy. Display notification errors and retry/recovery affordances distinctly from webhook delivery failures.

## Ideas, boundaries, and open work

External uptime/canary monitors are configured through the [runbook](runbook.md#monitoring), not by creating an alert channel. Exact rule bounds and defaults remain in shared schemas.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/jobs/alerts/rules.ts](../apps/gateway/src/jobs/alerts/rules.ts)
- [apps/gateway/src/jobs/alerts/job.ts](../apps/gateway/src/jobs/alerts/job.ts)
- [apps/gateway/src/admin/routes/alerts.ts](../apps/gateway/src/admin/routes/alerts.ts)
- [apps/gateway/src/admin/routes/alert-channels.ts](../apps/gateway/src/admin/routes/alert-channels.ts)
- [apps/dashboard/src/pages/AlertDetailPage.tsx](../apps/dashboard/src/pages/AlertDetailPage.tsx)
- [apps/gateway/test/jobs/alerts-rules.test.ts](../apps/gateway/test/jobs/alerts-rules.test.ts)

