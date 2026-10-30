# Archives and retention

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

An event may leave hot D1 storage only when all deliveries are terminal and its retention window has elapsed. Fully delivered events use hot retention; events with failed/dead deliveries use the longer failed retention. Active or paused work remains in D1.

With archiving enabled, a workflow writes self-contained gzip NDJSON parts and a manifest to R2, verifies them, and then purges eligible D1 rows. Replay clears archive marking; purge rechecks eligibility. With `archive_enabled=false`, retention still deletes eligible records but creates no downloadable archive files.

## Design and interaction

Defaults: hot retention 30 days, failed retention 90 days, audit retention 365 days, archive retention null (indefinite). Invalid storage configuration stops the archive planner rather than guessing destructive settings.

UI `/archives` lists batches/parts; Settings → Storage previews consequences and can trigger a run. API: GET `/api/admin/v1/archives`, GET `/archives/preview`, POST `/archives/run`, GET `/archives/:batchId/parts/:n`. Metadata requires `events.read`, download requires `payload.read`, preview/run requires `settings.manage`.

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
- [apps/gateway/test/jobs/archive-verify-purge.test.ts](../apps/gateway/test/jobs/archive-verify-purge.test.ts)

