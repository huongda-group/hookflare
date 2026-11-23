# Alerts and notification channels

[Documentation index](README.md)

## Business rules and current behavior

Alert rules track operational incidents such as consecutive destination failures, newly dead deliveries, stuck pending work, D1 storage pressure, stuck archives, and stale backups. Incidents can open, resolve, and produce notifications with cooldown. A `consecutive_failures` incident resolves only after its destination has stayed under the failure threshold for 10 minutes (`FAILURES_QUIET_MS`); a new failure streak inside that window keeps the same incident open without new opened/resolved notifications. While it waits, the incident's details carry `cleared_at`. Other rules resolve on the first run their condition is clear (`new_dead` keeps its own `dead_quiet_s`, and `d1_storage` its 5-point hysteresis).

The alerts job runs inside the every-minute cron after reconcile and before session purge; it starts no new notification send after 15 seconds, leaving headroom for both in the same invocation. Notification delivery is tracked separately from incident state.

Admins configure rules and Discord, Slack, or Telegram channels. Channel configuration is encrypted; secret values are not returned through read endpoints. Outbound channel requests are restricted to the supported provider endpoints.

## Design and interaction

UI `/alerts` and `/alerts/:alertId` show incident metadata and notification history. Reading incidents via `/api/admin/v1/alerts` requires `events.read`. Settings → Alerts edits rules and channels; `/api/admin/v1/alert-channels` requires `settings.manage` for list, create, update, delete, and test.

Alerts shows the active project's incidents and a separate **Deployment incidents** section. Deployment incidents remain visible when switching projects and do not count toward the dashboard's project Overview. The API's incident list and detail accept `project_id` for one project or `scope=deployment` for incidents without a project. The two parameters are mutually exclusive; omitting both retains unscoped behavior. Rules and channels are still managed at deployment level.

Notification links without a scope resolve the incident's project or deployment scope after sign-in. An explicitly scoped detail link is never silently redirected to another project.

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
- [apps/gateway/tests/jobs/alerts-rules.test.ts](../apps/gateway/tests/jobs/alerts-rules.test.ts)
