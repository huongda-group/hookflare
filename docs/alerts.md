# Alerts and notification channels

[Documentation index](README.md)

## Business rules and current behavior

Alert rules open incidents for operational conditions, resolve them when the condition clears, and notify channels on open, reminder, and resolve. Rule settings live in the `alert_rules` settings row (defaults: `failure_threshold` 5, `stuck_after_s` 300, `dead_quiet_s` 1800, `d1_warn_pct` 80, `reminder_s` 3600; bounds in the shared schema).

| Rule | Resource | Condition |
| --- | --- | --- |
| `consecutive_failures` | destination | An `active` destination's consecutive-failure counter is at or above `failure_threshold`. |
| `new_dead` | destination | Deliveries became `dead` since the dead cursor. |
| `stuck_pending` | destination | `pending`/`queued` deliveries older than `stuck_after_s` on an `active` destination. |
| `d1_storage` | system `d1` | D1 size (from query metadata) is at least `d1_warn_pct` of 10 GiB. |
| `archive_stuck` | system `archive` | A `failed` archive batch with no later `verified`/`purged`/`expired` batch of the same kind and day, or a batch `building` or `verified` for more than 48 hours. |
| `backup_stale` | system `backup` | Backups are enabled and no verified backup finished in the last 36 hours. |

Resolution and hysteresis:

- `consecutive_failures`: one success resets the destination's counter, but the incident resolves only after the destination has stayed under the threshold for 10 minutes (`FAILURES_QUIET_MS`). The first clear run records `cleared_at` in the incident details; a new failure streak inside the window removes it and keeps the same incident open without new opened/resolved notifications. Paused or disabled destinations never match.
- `new_dead`: each run reads dead deliveries from the `alerts.dead_cursor` setting up to 10 seconds before now (room for clock skew between isolates), oldest first, at most 1,000 rows and 100 destinations; the rest is read next run. A missing cursor starts at the current time without alerting on history. New dead deliveries add to an open incident's count and five newest delivery IDs; the incident stays open until `dead_quiet_s` passes without a new one. The cursor moves in the same batch as the opens and never moves backward.
- `d1_storage` opens at `d1_warn_pct` and stays open until usage drops below `d1_warn_pct − 5`.
- `backup_stale`: disabled backups never alert. A deployment with no backup row yet gets 36 hours from when the baseline migration was applied (the newest migration if the baseline row is missing).
- Other rules resolve on the first run where their condition is clear.

The alerts job runs inside the every-minute cron after reconcile and before session purge. Each run evaluates rules, opens new incidents, resolves clear ones, and queues a reminder for an incident still open `reminder_s` after its last notification (`0` disables reminders). At most 100 opens (`new_dead` excepted; its scan bounds it), 100 resolves, and 100 reminders are written per run; the rest wait for the next run. Each incident change is its own D1 batch together with its notification rows, so one failure does not block the others; `new_dead` opens and updates share one batch with the dead-cursor move; a partial unique index makes a concurrent open a no-op, and notification rows are written only when the run's own state change landed.

Notification delivery is tracked separately from incident state. A channel receives an incident when its `rules` list is empty or contains the rule, and its `project_ids` list is empty or contains the incident's project; deployment incidents reach only channels without a project filter. The sender claims up to 50 pending notifications, sends 10 at a time with a 5-second timeout, and tries each up to 3 times. It starts no new send after 15 seconds, leaving the rest of the minute for reconcile and session purge, and returns unsent claims untouched. A claim older than 60 seconds is taken over by a later run; every result is written only while the run still owns the claim. Any 2xx response is success; redirects are not followed, response bodies are not stored, and errors are stored truncated with channel secrets redacted. A disabled channel fails its notification without retry. Messages are plain text of at most 1,800 characters and link to `PUBLIC_BASE_URL/alerts/<id>` when `PUBLIC_BASE_URL` is set.

Admins configure rules and Discord, Slack, or Telegram channels. Discord URLs must be `https://discord.com/api/webhooks/…` (or `discordapp.com`), Slack URLs `https://hooks.slack.com/services/…`, and Telegram channels take a bot token and a numeric chat ID or `@channel`; the sender checks the endpoint again before every request. The whole channel configuration is encrypted with `SECRETS_KEY`; read endpoints return only a fingerprint and, for Telegram, the chat ID.

## Design and interaction

UI `/alerts` and `/alerts/:alertId` show incident metadata and notification history. Reading incidents via `/api/admin/v1/alerts` requires `events.read`; the list filters by `status`, `rule`, and scope. Settings → Alerts edits rules through PATCH `/api/admin/v1/settings` (`alert_rules`, `settings.manage`) and channels through `/api/admin/v1/alert-channels`, which requires `settings.manage` for list, create, update, delete, and test. A test sends a fixed test message and records an `alert_channel.tested` audit row.

Alerts shows the active project's incidents and a separate **Deployment incidents** section. Deployment incidents remain visible when switching projects and do not count toward the dashboard's project Overview. The API's incident list and detail accept `project_id` for one project or `scope=deployment` for incidents without a project. The two parameters are mutually exclusive; omitting both returns incidents of every scope. Rules and channels are managed at deployment level.

Notification links without a scope resolve the incident's project or deployment scope after sign-in. An explicitly scoped detail link is never silently redirected to another project.

A channel test result must not imply the incident rules or external monitoring are all healthy. Display notification errors and retry/recovery affordances distinctly from webhook delivery failures.

## Ideas, boundaries, and open work

External uptime/canary monitors are configured through the [runbook](runbook.md#monitoring), not by creating an alert channel.

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/jobs/alerts/rules.ts](../apps/gateway/src/jobs/alerts/rules.ts)
- [apps/gateway/src/jobs/alerts/job.ts](../apps/gateway/src/jobs/alerts/job.ts)
- [apps/gateway/src/core/db/alerts.ts](../apps/gateway/src/core/db/alerts.ts)
- [apps/gateway/src/core/alert-channels.ts](../apps/gateway/src/core/alert-channels.ts)
- [apps/gateway/src/admin/routes/alerts.ts](../apps/gateway/src/admin/routes/alerts.ts)
- [apps/gateway/src/admin/routes/alert-channels.ts](../apps/gateway/src/admin/routes/alert-channels.ts)
- [packages/shared/src/admin.ts](../packages/shared/src/admin.ts) (`alertRulesSchema`, `alertChannelConfigSchema`)
- [apps/dashboard/src/pages/AlertsPage.tsx](../apps/dashboard/src/pages/AlertsPage.tsx)
- [apps/dashboard/src/pages/AlertDetailPage.tsx](../apps/dashboard/src/pages/AlertDetailPage.tsx)
- [apps/dashboard/src/pages/settings/AlertsTab.tsx](../apps/dashboard/src/pages/settings/AlertsTab.tsx)
- [apps/gateway/tests/jobs/alerts-rules.test.ts](../apps/gateway/tests/jobs/alerts-rules.test.ts)
- [apps/gateway/tests/jobs/alerts-job.test.ts](../apps/gateway/tests/jobs/alerts-job.test.ts)
- [apps/gateway/tests/admin/alerts.test.ts](../apps/gateway/tests/admin/alerts.test.ts)
- [apps/gateway/tests/admin/alert-channels.test.ts](../apps/gateway/tests/admin/alert-channels.test.ts)
- [apps/gateway/tests/core/alert-channels.test.ts](../apps/gateway/tests/core/alert-channels.test.ts)
- [apps/dashboard/tests/pages/AlertDetailPage.test.tsx](../apps/dashboard/tests/pages/AlertDetailPage.test.tsx)
