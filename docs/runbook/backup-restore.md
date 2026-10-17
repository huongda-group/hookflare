# Backup and restore

Two restore paths. **Path A (Time Travel, in place)** is the primary path
for anything noticed within 30 days. **Path B (R2 copy into a new
database)** is the last resort: the database is gone, or the damage is
older than 30 days. Decide with the
[rollback decision table](rollback.md#decision-table).

> [!NOTE]
> The commands below are derived from `scripts/deploy.mjs`,
> `scripts/restore-backup.mjs`, `scripts/verify-restore.mjs`, and
> `scripts/lib/deploy.mjs`, but have **not yet been executed against live
> staging** (the restore drill is pending). Every live-staging command is
> marked **(verify on staging in drill)**. Do not treat an unmarked command
> as verified — check the drill records in `drills/`.

The nightly backup runs by itself: the `0 20 * * *` cron starts a
`BackupWorkflow` run (`backup-YYYY-MM-DD`) only while
`backup_enabled` is on (Settings › Storage). It pages every table into
gzip NDJSON parts plus a `manifest.json` under
`d1/YYYY/MM/DD/<backup_id>/` in the backups bucket
(`hookflare-backups-staging` on staging, `hookflare-backups` in
production), then verifies every part and enforces
`backup_retention_days` (default 35). "Run backup now" in Settings ›
Storage (admin only, audited as `backup.run`) starts a manual run. If no
`verified` backup appears within 36 hours, the `backup_stale` alert fires.

## Path A: Time Travel restore (in place)

Restores D1 to a bookmark (or timestamp) within the last 30 days.

> [!WARNING]
> **A Time Travel restore loses every write after the restore point,
> including webhooks already acknowledged with `202` — providers will not
> resend them.** The deploy record (`.deploy/<timestamp>.json`) holds the
> bookmark from before the release. Use this path only when that loss is
> smaller than the damage being undone.

1. **Pick the restore point.** Use the `bookmark` from the deploy record
   (`.deploy/<timestamp>.json`, printed by `scripts/deploy.mjs`), or list
   recent bookmarks (verify on staging in drill):
   ```bash
   pnpm exec wrangler d1 time-travel info <d1-name> --json --config apps/gateway/wrangler.staging.jsonc
   ```
   (`<d1-name>` is `hookflare-staging-db` on staging, the production
   database name in production with `apps/gateway/wrangler.jsonc`.)
2. **Pause every destination** (dashboard Destinations page, or the admin
   API) if deliveries must not run against the old state.
3. **Restore** (verify on staging in drill):
   ```bash
   pnpm exec wrangler d1 time-travel restore <d1-name> --bookmark=<bookmark> --config apps/gateway/wrangler.staging.jsonc
   ```
   Keep the "undo" bookmark the command prints — it is the way back if
   the restore was wrong.
4. **Roll back the Worker** to the recorded version if the release itself
   is bad (see [rollback.md](rollback.md)).
5. **Smoke-test** (verify on staging in drill):
   ```bash
   pnpm smoke:staging
   ```
   Expected: exit 0, the event ID and two delivery IDs.
6. **Resume** the paused destinations.

## Path B: R2 copy into a new database

Restores the latest `verified` R2 backup into a fresh database. The copy
is **not a point-in-time snapshot** — each table was read minutes apart —
so rows whose parent row is missing are skipped and reported in
`orphans.json`, never silently lost. Time Travel stays the primary path.

Find the backup prefix from Settings › Storage (last verified backup:
time, size, rows) or the `backups` table. Prefixes look like
`d1/YYYY/MM/DD/<backup_id>/`.

### Step 1 — create the database and migrate it (verify on staging in drill)

```bash
pnpm exec wrangler d1 create hookflare-restore-<date> --config apps/gateway/wrangler.staging.jsonc
```

Copy the config next to the original, e.g.
`apps/gateway/wrangler.restore.jsonc` (do not commit it; never edit the
committed configs in place for a restore database), and put the new
`database_id` in its `DB` entry of `d1_databases`.

The new database must end up with **exactly** the migrations listed in
the backup's `manifest.json` `d1_migrations` — no more, no fewer — or
the backed-up rows will not fit the schema. Copy exactly those
migration files out of the repository:

```bash
node scripts/restore-backup.mjs --prefix d1/YYYY/MM/DD/<backup_id>/ --prepare-migrations
```

This downloads the manifest to `.restore/<backup_id>/manifest.json` and
copies each listed file from `apps/gateway/migrations/` into
`.restore/<backup_id>/migrations/`, printing that absolute path. It
refuses, copying nothing, if a listed migration is missing from the
checkout (the backup was taken by a newer release): check out the
release that took the backup (its deploy record, or the latest commit
whose `apps/gateway/migrations/` contains every listed name) and run it
again. Then set `"migrations_dir": "<printed path>"` in the
restore config's `DB` entry and apply:

```bash
pnpm exec wrangler d1 migrations apply DB --remote --config apps/gateway/wrangler.restore.jsonc
```

### Step 2 — restore the rows (verify on staging in drill)

```bash
node scripts/restore-backup.mjs --prefix d1/YYYY/MM/DD/<backup_id>/ --config apps/gateway/wrangler.restore.jsonc
```

The scripts run the repository's pinned wrangler
(`node_modules/.bin/wrangler`, after `pnpm install`) and fall back to
`wrangler` on `PATH` if it is missing.

Before writing anything the script refuses to continue when:

- the target `database_id` is the production database in
  `apps/gateway/wrangler.jsonc` — always, there is no override;
- the target is the staging database in
  `apps/gateway/wrangler.staging.jsonc`, unless `--allow-known-db` is
  passed (only for a deliberate restore over staging; a drill restores
  into a new database and never needs it);
- the target's `d1_migrations` differ from the manifest's (it prints the
  missing and extra names — redo step 1);
- any manifest table on the target already has rows (it prints the
  counts). This check is skipped when resuming.

Then it downloads `manifest.json` and every part from the backups bucket
(`--bucket` defaults to `hookflare-backups`; pass
`--bucket hookflare-backups-staging` on staging), checks every sha256
(parts already on disk with the right sha256 are not downloaded again),
streams the rows into numbered SQL files of at most 50 MB under
`.restore/<backup_id>/sql/` (tables in parent-before-child order; every
statement stays under 90 KB, with large TEXT and BLOB values appended in
chunks), and applies each file with `wrangler d1 execute DB --remote
--file`. Rows with a missing parent — including rows below an orphaned
row in a self-referencing table — are skipped and counted in
`.restore/<backup_id>/orphans.json`, which holds only each orphan's
table, key and foreign-key values (never bodies or secrets). Pass
`--dry-run` to download and generate without querying or applying.

**Resuming.** Each applied file is recorded in
`.restore/<backup_id>/applied.json` (with the target `database_id` and
the file's sha256). If a file fails, the script prints
`restore: stopped at NNNN.sql` and exits 1. Fix the cause and re-run the
same command: it regenerates the same SQL, skips the recorded files, and
continues from the failed one. D1 applies a `--file` import as a single
unit, so a failed file should have left no rows (verify on staging in
drill); if re-applying it fails with a `UNIQUE constraint` error, the
file was partly applied — restore into a fresh database instead. `--from NNNN` starts at file
`NNNN` regardless of `applied.json` (use it only if `applied.json` was
lost; files before `NNNN` must already be applied). The script refuses to
resume against a different `database_id` than the one in `applied.json`,
or if a recorded file was regenerated with different contents.

### Step 3 — verify (verify on staging in drill)

```bash
node scripts/verify-restore.mjs --prefix d1/YYYY/MM/DD/<backup_id>/ --config apps/gateway/wrangler.restore.jsonc
```

Checks that each manifest table's `rows` equals the sum of its parts'
rows (a mismatch means the manifest itself is inconsistent — use another
backup), `PRAGMA integrity_check`, an empty `PRAGMA foreign_key_check`,
row counts equal to the manifest minus `orphans.json`, per-column BLOB
byte totals equal to the manifest minus orphaned BLOBs, and
`d1_migrations` equal to the manifest. Exit 1 on any difference —
do not proceed until every check passes.

### Step 4 — point a Worker at it and smoke-test (verify on staging in drill)

Change `database_id` in the config to the restored database, deploy, and
smoke-test:

```bash
pnpm exec wrangler deploy --config apps/gateway/wrangler.restore.jsonc
pnpm smoke:staging
```

For the drill, point a scratch Worker (`hookflare-restore-drill`) at the
restored database, smoke-test it, then delete the scratch database and
Worker. On production, only path B is ever drilled, into a scratch
database that is deleted afterwards. Repeat every quarter.

## What a D1 restore does NOT touch: R2

A D1 restore (either path) does not touch R2 objects:

- **Payloads.** Events restored to a point before their payload objects
  (`events/…`) were written — or after they were deleted — come back
  with a missing payload. Delivery and replay already handle that as
  `payload_missing` (the delivery is finished without calling the
  backend; replay skips the event); nothing else needs doing.
- **Archives.** Archive batches (`archive/…`) written after a path-A
  restore point stay in R2 but are no longer listed, because the listing
  comes from D1. Find them by their key prefix
  (`archive/YYYY/MM/DD/<batch_id>/`) and re-import or expire them by hand.
- **The backups bucket itself** is never restored — it is the source you
  restore *from*. Its 7-day bucket lock rule means even a mistaken delete
  cannot remove the most recent copies.

## Secrets

`SECRETS_KEY` is the one thing a backup cannot replace — see
[secrets.md](secrets.md). Re-enter it (and the other secrets listed
there) before smoke-testing any restored deployment.
