# Settings and policy defaults

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

Settings contains Retry defaults, Storage, Alerts, and Users. All authenticated roles can read settings through `events.read`; mutation requires `settings.manage`. The interface exposes Storage/Alerts to admins and Users through `users.manage`; unauthorized requested tabs fall back to Retry.

Stored groups are `retry_defaults`, `storage`, and `alert_rules`. Destination policy fields override corresponding retry defaults. Runtime caches can delay propagation up to 30 seconds.

## Design and interaction

API GET/PATCH `/api/admin/v1/settings` uses validated section objects. Each section is a separate versioned settings row; the route compares its read version during writes and returns 409 on a concurrent conflict. A multi-section conflict can occur after another section was written: reload server state before retrying.

Keep save states and server validation visible. Retention forms must explain that disabling archive files does not disable deletion. Surface archive/backup run state separately from the settings save result. Rules/channels are covered by [alerts](alerts.md), storage by [archives](archives.md) and [backup](backup-restore.md).

## Ideas, boundaries, and open work

Themes, localization, per-user preferences, and arbitrary runtime configuration are not part of this settings API.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/admin/routes/settings.ts](../apps/gateway/src/admin/routes/settings.ts)
- [apps/gateway/src/core/settings.ts](../apps/gateway/src/core/settings.ts)
- [packages/shared/src/admin.ts](../packages/shared/src/admin.ts)
- [apps/dashboard/src/pages/SettingsPage.tsx](../apps/dashboard/src/pages/SettingsPage.tsx)
- [apps/gateway/test/admin/settings.test.ts](../apps/gateway/test/admin/settings.test.ts)

