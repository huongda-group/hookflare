# Audit trail

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

Audit history explains who changed what and why. Actors are usernames; older email-shaped actor values can remain historical data. Configuration changes, replay, account administration, secret rotation, and relevant operational actions have redacted audit records.

Ordinary database mutations and their audit rows are batched together. External workflow starts cannot share a D1 transaction: archive start logs an audit-write failure after starting. Do not turn the general atomic-audit design goal into a guarantee across external side effects.

## Design and interaction

UI `/audit`; API GET `/api/admin/v1/audit-logs` requires `audit.read` (admin). Use filters/cursors, recognizable resources, reason, time, and redacted changes. Viewers/operators must not fetch protected audit data merely because a hidden component mounted.

Passwords, tokens, secret configuration, and hashes never belong in diffs. Login success/failure uses Worker logs rather than unauthenticated audit writes. Audit retention and archive rules apply separately from event retention.

## Ideas, boundaries, and open work

Audit is operational traceability, not a claim of regulatory certification or an immutable external ledger.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/core/audit.ts](../apps/gateway/src/core/audit.ts)
- [apps/gateway/src/admin/routes/audit-logs.ts](../apps/gateway/src/admin/routes/audit-logs.ts)
- [apps/gateway/src/admin/routes/archives.ts](../apps/gateway/src/admin/routes/archives.ts)
- [apps/dashboard/src/pages/AuditPage.tsx](../apps/dashboard/src/pages/AuditPage.tsx)
- [apps/gateway/test/admin/audit-logs.test.ts](../apps/gateway/test/admin/audit-logs.test.ts)

