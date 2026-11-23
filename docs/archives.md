# Archives and retention

[Documentation index](README.md)

## Business rules and current behavior

An event may leave hot D1 storage only when every delivery is terminal (`delivered`, `failed_final`, or `dead`; an event without deliveries counts as delivered) and its retention window has elapsed. Fully delivered events use hot retention; events with a `failed_final`/`dead` delivery use the longer failed retention. Active or paused work remains in D1. Audit rows older than the audit retention (whole UTC days) are archived and deleted the same way, as `audit` batches.

The archive Workflow starts daily at 03:00 UTC (instance `archive-YYYY-MM-DD`, so a second start the same day is ignored) or manually. It runs as Workflow steps:

1. **Plan.** A corrupt `storage` settings row stops the run rather than guessing destructive settings. The planner first resumes its own and abandoned unfinished batches (`building` or `verified` whose Workflow instance is no longer running; an instance in Workflows status `unknown` counts as running, so two instances never work on one batch), then creates one batch per UTC day and kind, oldest day first. A run is limited to 8,000 Workflow steps and a batch to 200 parts; what does not fit is left to a later batch.
2. **Build parts.** Each part takes up to 5,000 unmarked eligible events of the day, ordered by ID, and stops before 32 MiB of raw payload (always at least one event). Marking (`archive_batch_id`, `archive_part`) is one statement, so concurrent instances never mark the same event. Each gzip NDJSON line holds the event's columns, `payload_b64`, and its deliveries with their attempts; audit lines are `{"v":1,"audit":…}` and audit parts are ID ranges within the day. Part keys are deterministic and a retry overwrites them.
3. **Verify.** Every part object must exist with the recorded size and SHA-256, and no part may have more live D1 rows than it archived (replay only removes marks). Then the manifest is written and the batch becomes `verified`. Any mismatch sets `failed`: a failed batch is never purged, releases its marks in the same D1 batch, and its day is archived again by a later batch.
4. **Purge.** Events are deleted per part in chunks of 500. Each delete repeats the mark, eligibility, and `verified` checks in its own transaction, so an event that was replayed (unmarked) or got a live delivery after its part was built survives. R2 payload objects are deleted only for events that are actually gone from D1. Finishing sets `purged` and clears the marks of every event left in D1, so a later batch archives it.
5. **Retention.** Files of `failed` batches are deleted (`with_files` becomes false). When `archive_retention_days` is set, `purged` batches whose `purged_at` is older than that are deleted from R2 and become `expired`; `null` keeps them forever. Each of the two cleanups handles at most 50 batches per run.

Files live in the `PAYLOADS` bucket under `archive/YYYY/MM/DD/<batch_id>/` (audit: `archive/audit/YYYY/MM/DD/<batch_id>/`) as `part-NNNN.ndjson.gz` plus `manifest.json`. One day can be archived by several batches. An event replayed after being archived can appear in more than one batch; the copy in the newest batch is the complete one.

An event whose R2 payload object is missing when its part is built (for example after a D1 restore to before a purge) is left out of the part file, logged as `archive.payload_missing`, and stays in D1. It keeps the batch's mark with `archive_part = 0`, which no part row uses, so purge never deletes it and later parts and runs skip it; the run continues with the rest of the day even when a whole part's worth of events is missing. After restoring the payload objects, clear the mark (`archive_batch_id` and `archive_part` set to NULL) so the next run archives those events.

With `archive_enabled=false`, new batches have `with_files=false`: retention still verifies counts and deletes eligible records, but writes no archive files.

## Design and interaction

Defaults: hot retention 30 days, failed retention 90 days (must be at least hot retention), audit retention 365 days, archive retention null (indefinite), archiving enabled.

UI `/archives` lists batches/parts; Settings → Storage previews consequences and can trigger a run. API: GET `/api/admin/v1/archives` (filters `kind`, `status`, `from_day`, `to_day`, cursor), GET `/archives/preview` (counts events eligible under the proposed `hot_retention_days`/`failed_retention_days` and under the current settings), POST `/archives/run`, GET `/archives/:batchId/parts/:n`. Metadata requires `events.read`, download requires `payload.read` (audit-kind batches also require `audit.read`), preview/run requires `settings.manage`. A run returns `409 archive_running` while the last started run is still active; downloads and run starts are audited (`archive.downloaded`, `archive.run_started`).

Archive batches and downloads are deployment-wide, regardless of the dashboard's active project.

Use actual batch statuses (`building`, `verified`, `purged`, `failed`, `expired`) and `with_files`. Download is available only for parts of `verified`/`purged` batches with files. A run-start 202 means workflow accepted, not archive complete.

## Ideas, boundaries, and open work

Archives support listing/downloading, not search, replay, or restoring an archived day into D1. Archival is not the same as a database backup; see [backup and restore](backup-restore.md).

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/core/db/archive.ts](../apps/gateway/src/core/db/archive.ts)
- [apps/gateway/src/core/archive-run.ts](../apps/gateway/src/core/archive-run.ts)
- [apps/gateway/src/jobs/archive/run.ts](../apps/gateway/src/jobs/archive/run.ts)
- [apps/gateway/src/jobs/archive/plan.ts](../apps/gateway/src/jobs/archive/plan.ts)
- [apps/gateway/src/jobs/archive/part.ts](../apps/gateway/src/jobs/archive/part.ts)
- [apps/gateway/src/jobs/archive/verify.ts](../apps/gateway/src/jobs/archive/verify.ts)
- [apps/gateway/src/jobs/archive/purge.ts](../apps/gateway/src/jobs/archive/purge.ts)
- [apps/gateway/src/jobs/archive/retention.ts](../apps/gateway/src/jobs/archive/retention.ts)
- [apps/gateway/src/admin/routes/archives.ts](../apps/gateway/src/admin/routes/archives.ts)
- [apps/dashboard/src/pages/ArchivesPage.tsx](../apps/dashboard/src/pages/ArchivesPage.tsx)
- [apps/dashboard/src/pages/settings/StorageTab.tsx](../apps/dashboard/src/pages/settings/StorageTab.tsx)
- [apps/gateway/tests/jobs/archive-plan.test.ts](../apps/gateway/tests/jobs/archive-plan.test.ts)
- [apps/gateway/tests/jobs/archive-part.test.ts](../apps/gateway/tests/jobs/archive-part.test.ts)
- [apps/gateway/tests/jobs/archive-run.test.ts](../apps/gateway/tests/jobs/archive-run.test.ts)
- [apps/gateway/tests/jobs/archive-verify-purge.test.ts](../apps/gateway/tests/jobs/archive-verify-purge.test.ts)
- [apps/gateway/tests/admin/archives.test.ts](../apps/gateway/tests/admin/archives.test.ts)
- [apps/dashboard/tests/pages/ArchivesPage.test.tsx](../apps/dashboard/tests/pages/ArchivesPage.test.tsx)
