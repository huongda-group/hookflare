# Settings and policy defaults

[Documentation index](README.md)

## Business rules and current behavior

Settings contains Retry defaults, Storage, Alerts, and Users. All authenticated roles can read settings through `events.read`; mutation requires `settings.manage`. The Retry defaults tab is visible to everyone and read-only without `settings.manage`; Storage and Alerts require `settings.manage`, and Users requires `users.manage`. A requested tab the user cannot open falls back to Retry.

Stored sections are `retry_defaults`, `storage`, and `alert_rules`, each in its own settings row. A missing, unparsable, or out-of-bounds row reads as the built-in defaults (the read logs a warning for an invalid row), so deliveries never fail on a bad settings row. Retry defaults are `timeout_ms` (1,000–30,000; default 10,000), `max_attempts` (1–50; default 20), `backoff_base_s` (1–3,600; default 30), and `backoff_max_s` (1–43,200, at least `backoff_base_s`; default 21,600). Destination policy fields override the corresponding retry defaults per field. Retry defaults and alert rules are cached per isolate for 30 seconds: the isolate that saves clears its cache immediately, and others pick up the change within the cache lifetime.

## Design and interaction

Content sections in all four Settings tabs span the same content width as other dashboard pages.

API `GET /api/admin/v1/settings` returns `retry_defaults`, `alert_rules`, `storage`, each section's version timestamp (`updated_at` for retry defaults, `alert_rules_updated_at`, `storage_updated_at`; `null` when the row does not exist), and `archive_last_run`. `PATCH` takes one or more validated sections plus an optional `reason`; unknown fields or an empty request are `400 invalid_request`. Each section is compared against the version read at the start of the request and written with a new, strictly increasing version, together with one `settings.updated` [audit](audit.md) entry whose resource ID is the section key and whose diff holds the before and after values. A PATCH is all-or-nothing: if any of its sections changed concurrently, a guard statement fails the batch, no section and no audit row is written, and the route returns `409 conflict`. Reload server state before retrying. A successful PATCH returns the full settings response.

Keep save states and server validation visible. The Retry defaults form shows field errors, an optional reason (up to 500 characters), Save and Revert, and confirms that the change applies to new attempts within 30 seconds; without `settings.manage` it shows disabled fields and explains the missing permission. Retention forms must explain that disabling archive files does not disable deletion. Surface archive/backup run state separately from the settings save result. Rules/channels are covered by [alerts](alerts.md), storage by [archives](archives.md) and [backup](backup-restore.md), and the Users tab by [users](users.md).

## Ideas, boundaries, and open work

Themes, localization, per-user preferences, and arbitrary runtime configuration are not part of this settings API.

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/admin/routes/settings.ts](../apps/gateway/src/admin/routes/settings.ts)
- [apps/gateway/src/core/settings.ts](../apps/gateway/src/core/settings.ts)
- [apps/gateway/src/core/policy.ts](../apps/gateway/src/core/policy.ts)
- [packages/shared/src/admin.ts](../packages/shared/src/admin.ts)
- [apps/dashboard/src/pages/SettingsPage.tsx](../apps/dashboard/src/pages/SettingsPage.tsx)
- [apps/dashboard/src/pages/settings/RetryDefaultsTab.tsx](../apps/dashboard/src/pages/settings/RetryDefaultsTab.tsx)
- [apps/gateway/tests/admin/settings.test.ts](../apps/gateway/tests/admin/settings.test.ts)
- [apps/gateway/tests/core/settings.test.ts](../apps/gateway/tests/core/settings.test.ts)
- [apps/dashboard/tests/pages/SettingsPage.test.tsx](../apps/dashboard/tests/pages/SettingsPage.test.tsx)
- [apps/dashboard/tests/pages/settings/RetryDefaultsTab.test.tsx](../apps/dashboard/tests/pages/settings/RetryDefaultsTab.test.tsx)
