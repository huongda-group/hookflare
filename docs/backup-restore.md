# Backups and restore

[Documentation index](README.md)

## Business rules and current behavior

Backups support operational recovery, while [archives](archives.md) support retention. `BackupWorkflow` dumps every D1 table to the `BACKUPS` R2 bucket, writes and verifies a manifest, and applies backup retention. Backups are enabled by default with 35-day retention (7–365 days).

The cron starts a backup daily at 20:00 UTC (instance and backup ID `backup-YYYY-MM-DD`) when backups are enabled and no backup is running; a second run would only double the D1 read load. A manual run uses ID `backup-YYYY-MM-DD-manual-<id>`. Only one backup can be `running` (a partial unique index enforces it). A `running` row whose Workflow instance has ended (errored, terminated, complete) or is gone from Workflows retention is marked `failed` so the next run can start; an instance in status `unknown` counts as running.

Each backup lives under `d1/YYYY/MM/DD/<backup_id>/`. Tables come from `sqlite_schema`, skipping SQLite internals, Cloudflare `_cf_*` tables, and the migration journal. Each part is gzip NDJSON of up to 5,000 rows (250 rows for tables with BLOB columns), paged by the table's single-column primary key or by rowid; BLOB cells are stored as `{"$b64": …}`. A per-part sidecar lets the manifest step rebuild the parts list from R2. When a Workflow instance nears its step budget (900 steps), it starts a continuation instance (`<id>-cont-N`) that resumes at the same table and cursor; the table list is pinned by the first instance, a pinned table that disappears fails the backup, and tables created since are left out and logged.

The manifest records the applied `d1_migrations`, every table with its columns, foreign keys, row count, and parts (row counts, bytes, SHA-256, BLOB byte totals). Verification re-reads the manifest and checks size and SHA-256 of the manifest and every part. Any mismatch marks the backup `failed`; a failed backup keeps its R2 objects for inspection.

Retention runs after a verified backup (only while backups are enabled). It drops backups whose `started_at` is older than `backup_retention_days`, except the newest `verified` backup, which is always kept as the restore fallback, and except `running` rows. The row becomes `expiring` before any object is deleted, so a half-deleted backup never claims to be restorable; if the R2 delete fails (for example under a bucket lock), the row stays `expiring` and the next run retries it.

The R2 export reads tables over time and is not a point-in-time snapshot. Tables are dumped parents first (foreign-key order), so a row created between two table reads surfaces as an orphan child instead of a parent silently missing its children (for example an event without its delivery). Restore must handle missing parents, report skipped orphans, and pass verification before cutover. D1 Time Travel is a separate restore path.

## Design and interaction

Settings → Storage shows the backup summary (enabled state, last verified, last failed, and running backup) and manual-run controls. API: GET `/api/admin/v1/backups/summary` with `events.read`, POST `/backups/run` with `settings.manage`. A manual run returns `202` with `backup_id` and `instance_id`, or `409 backup_running` while another backup runs, and is audited as `backup.run`. The manual route does not check `backup_enabled`; a manual backup taken while backups are disabled skips retention.

Follow the [backup/restore runbook](runbook.md#backup-and-restore) for execution and [secrets](runbook.md#secrets) for recovery prerequisites. D1 restore does not restore R2 payload objects or Worker secrets. Missing payloads remain visible as errors; `SECRETS_KEY` is needed to decrypt restored configuration.

A successful start/backup does not prove a successful restore. Record actual drills under [runbook drills](runbook.md#drills).

## Ideas, boundaries, and open work

Existing drill templates are pending evidence, not completed live acceptance. Do not claim data consistency or recoverability from an unverified backup alone.

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/core/backup-run.ts](../apps/gateway/src/core/backup-run.ts)
- [apps/gateway/src/jobs/backup/run.ts](../apps/gateway/src/jobs/backup/run.ts)
- [apps/gateway/src/jobs/backup/tables.ts](../apps/gateway/src/jobs/backup/tables.ts)
- [apps/gateway/src/jobs/backup/dump.ts](../apps/gateway/src/jobs/backup/dump.ts)
- [apps/gateway/src/jobs/backup/manifest.ts](../apps/gateway/src/jobs/backup/manifest.ts)
- [apps/gateway/src/jobs/backup/verify.ts](../apps/gateway/src/jobs/backup/verify.ts)
- [apps/gateway/src/jobs/backup/retention.ts](../apps/gateway/src/jobs/backup/retention.ts)
- [apps/gateway/src/admin/routes/backups.ts](../apps/gateway/src/admin/routes/backups.ts)
- [scripts/restore-backup.mjs](../scripts/restore-backup.mjs)
- [scripts/verify-restore.mjs](../scripts/verify-restore.mjs)
- [scripts/lib/restore.mjs](../scripts/lib/restore.mjs)
- [apps/gateway/tests/jobs/backup-run.test.ts](../apps/gateway/tests/jobs/backup-run.test.ts)
- [apps/gateway/tests/jobs/backup-steps.test.ts](../apps/gateway/tests/jobs/backup-steps.test.ts)
- [apps/gateway/tests/jobs/backup-dump.test.ts](../apps/gateway/tests/jobs/backup-dump.test.ts)
- [apps/gateway/tests/admin/backups.test.ts](../apps/gateway/tests/admin/backups.test.ts)
- [scripts/tests/restore.test.mjs](../scripts/tests/restore.test.mjs)
