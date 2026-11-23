# Archives and retention

[Documentation index](README.md)

## Business rules and current behavior

An event may leave hot D1 storage only when all deliveries are terminal and its retention window has elapsed. Fully delivered events use hot retention; events with failed/dead deliveries use the longer failed retention. Active or paused work remains in D1.

With archiving enabled, a workflow writes self-contained gzip NDJSON parts and a manifest to R2, verifies them, and then purges eligible D1 rows. Replay clears archive marking; purge rechecks eligibility.

An event whose R2 payload object is missing when its part is built (for example after a D1 restore to before a purge) is left out of the part file, logged as `archive.payload_missing`, and stays in D1. It keeps the batch's mark with `archive_part = 0`, which no part row uses, so purge never deletes it and later parts and runs skip it; the run continues with the rest of the day even when a whole part's worth of events is missing. After restoring the payload objects, clear the mark (`archive_batch_id` and `archive_part` set to NULL) so the next run archives those events. With `archive_enabled=false`, retention still deletes eligible records but creates no downloadable archive files.

## Design and interaction

Defaults: hot retention 30 days, failed retention 90 days, audit retention 365 days, archive retention null (indefinite). Invalid storage configuration stops the archive planner rather than guessing destructive settings.

UI `/archives` lists batches/parts; Settings → Storage previews consequences and can trigger a run. API: GET `/api/admin/v1/archives`, GET `/archives/preview`, POST `/archives/run`, GET `/archives/:batchId/parts/:n`. Metadata requires `events.read`, download requires `payload.read` (audit-kind batches also require `audit.read`), preview/run requires `settings.manage`.

Archive batches and downloads are deployment-wide, regardless of the dashboard's active project.

Use actual batch statuses (`building`, `verified`, `purged`, `failed`, `expired`) and `with_files`. Download is available only for eligible verified/purged parts with files. A run-start 202 means workflow accepted, not archive complete.

## Ideas, boundaries, and open work

Archives support listing/downloading, not search, replay, or restoring an archived day into D1. Archival is not the same as a database backup; see [backup and restore](backup-restore.md).

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/core/db/archive.ts](../apps/gateway/src/core/db/archive.ts)
- [apps/gateway/src/jobs/archive/plan.ts](../apps/gateway/src/jobs/archive/plan.ts)
- [apps/gateway/src/jobs/archive/purge.ts](../apps/gateway/src/jobs/archive/purge.ts)
- [apps/gateway/src/admin/routes/archives.ts](../apps/gateway/src/admin/routes/archives.ts)
- [apps/dashboard/src/pages/ArchivesPage.tsx](../apps/dashboard/src/pages/ArchivesPage.tsx)
- [apps/gateway/tests/jobs/archive-verify-purge.test.ts](../apps/gateway/tests/jobs/archive-verify-purge.test.ts)
