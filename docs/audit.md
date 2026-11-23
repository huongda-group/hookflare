# Audit trail

[Documentation index](README.md)

## Business rules and current behavior

Audit history explains who changed what and why. Each entry has `id`, `actor` (the acting username), `action`, `resource_type`, `resource_id`, an optional `reason` (1–500 characters where a route accepts one), a redacted `diff`, and `at`. Recorded actions:

- Configuration: `project.created`/`updated`, `source.created`/`updated`/`secret_rotated`, `destination.created`/`updated`/`paused`/`resumed`/`secret_rotated`, `settings.updated` (one entry per changed section, see [settings](settings.md)), `alert_channel.created`/`updated`/`deleted`.
- Operations: `delivery.replayed`, `destination.tested`, `alert_channel.tested`, `event.payload_viewed`, `archive.downloaded`, `archive.run_started`, `backup.run`.
- Accounts: `user.onboarded`, `user.created`, `user.role_changed`, `user.disabled`, `user.enabled`, `user.password_reset`, `user.password_changed`, `api_token.created`, `api_token.revoked`.

Diffs are redacted before they are stored: any key containing `secret`, `token`, or `password` (case-insensitive) is dropped at any depth, and a `url` value keeps only its origin, because destination URLs can carry credentials in the path or query. Passwords, tokens, secret configuration, and hashes never appear in diffs. Login success and failure go to Worker logs rather than unauthenticated audit writes; reads of the audit trail are not audited.

Ordinary database mutations and their audit rows run in the same D1 batch. For conditional mutations, the audit row is written only if the statement just before it changed a row, so a no-op (for example revoking an already-revoked token) writes no audit entry. External workflow starts cannot share a D1 transaction: a manual backup writes its backup row and audit entry together before starting the workflow, and marks the backup failed if the start fails; a manual archive run starts the workflow first and then writes its audit entry, and if that write fails it logs `archive.run_audit_failed` and the request returns `500` while the run continues. Do not turn the general atomic-audit design goal into a guarantee across external side effects.

## Design and interaction

UI `/audit`; API `GET /api/admin/v1/audit-logs` requires `audit.read` (admin). Results are newest first with an opaque cursor (`limit` 1–100, default 50). Filters are exact matches on `actor` (trimmed and lowercased), `action`, `resource_type`, and `resource_id`, plus an inclusive `from`/`to` range in epoch milliseconds. The page exposes the four text filters, kept in the URL and applied when a field loses focus, and shows time, actor, action, resource, reason, and an expandable diff.

The Audit navigation item is hidden without `audit.read`, and the page does not request audit data for such users; a direct visit shows that the audit log requires the admin role. The audit trail is deployment-wide and does not follow the dashboard's active project.

Audit rows have their own retention (`audit_retention_days`, see [archives](archives.md)), separate from event retention. Downloading an audit archive also requires `audit.read`.

## Ideas, boundaries, and open work

Audit is operational traceability, not a claim of regulatory certification or an immutable external ledger.

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/core/audit.ts](../apps/gateway/src/core/audit.ts)
- [apps/gateway/src/core/db/audit-logs.ts](../apps/gateway/src/core/db/audit-logs.ts)
- [apps/gateway/src/admin/routes/audit-logs.ts](../apps/gateway/src/admin/routes/audit-logs.ts)
- [apps/gateway/src/admin/http.ts](../apps/gateway/src/admin/http.ts)
- [apps/gateway/src/admin/routes/archives.ts](../apps/gateway/src/admin/routes/archives.ts)
- [apps/gateway/src/admin/routes/backups.ts](../apps/gateway/src/admin/routes/backups.ts)
- [apps/dashboard/src/pages/AuditPage.tsx](../apps/dashboard/src/pages/AuditPage.tsx)
- [apps/gateway/tests/admin/audit-logs.test.ts](../apps/gateway/tests/admin/audit-logs.test.ts)
- [apps/gateway/tests/core/audit.test.ts](../apps/gateway/tests/core/audit.test.ts)
- [apps/dashboard/tests/pages/AuditPage.test.tsx](../apps/dashboard/tests/pages/AuditPage.test.tsx)
