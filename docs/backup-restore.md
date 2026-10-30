# Backups and restore

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

Backups support operational recovery, while archives support retention. A scheduled BackupWorkflow dumps tables to R2, writes and verifies a manifest, and applies backup retention. Defaults enable backup with 35-day retention.

The R2 export reads tables over time and is not a point-in-time snapshot. Restore must handle missing parents, report skipped orphans, and pass verification before cutover. D1 Time Travel is a separate restore path.

## Design and interaction

Settings → Storage shows backup summary and manual-run controls. API: GET `/api/admin/v1/backups/summary` with `events.read`, POST `/backups/run` with `settings.manage`.

Follow the [backup/restore runbook](runbook.md#backup-and-restore) for execution and [secrets](runbook.md#secrets) for recovery prerequisites. D1 restore does not restore R2 payload objects or Worker secrets. Missing payloads remain visible as errors; `SECRETS_KEY` is needed to decrypt restored configuration.

A successful start/backup does not prove a successful restore. Record actual drills under [runbook drills](runbook.md#drills).

## Ideas, boundaries, and open work

Existing drill templates are pending evidence, not completed live acceptance. Do not claim data consistency or recoverability from an unverified backup alone.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/jobs/backup/run.ts](../apps/gateway/src/jobs/backup/run.ts)
- [apps/gateway/src/jobs/backup/verify.ts](../apps/gateway/src/jobs/backup/verify.ts)
- [apps/gateway/src/admin/routes/backups.ts](../apps/gateway/src/admin/routes/backups.ts)
- [scripts/restore-backup.mjs](../scripts/restore-backup.mjs)
- [scripts/verify-restore.mjs](../scripts/verify-restore.mjs)
- [apps/gateway/test/jobs/backup-run.test.ts](../apps/gateway/test/jobs/backup-run.test.ts)

