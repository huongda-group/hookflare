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

Put the new `database_id` in a copy of the config (never edit the
committed staging config in place for a drill database), then apply the
repository migrations — only up to the last name in the backup's
`d1_migrations`, so the schema matches the backed-up rows:

```bash
pnpm exec wrangler d1 migrations apply DB --remote --config <restore-config>
```

### Step 2 — restore the rows (verify on staging in drill)

```bash
node scripts/restore-backup.mjs --prefix d1/YYYY/MM/DD/<backup_id>/ --config <restore-config>
```

What the script does: downloads `manifest.json` and every part from the
backups bucket (`--bucket` defaults to `hookflare-backups`; pass
`--bucket hookflare-backups-staging` on staging), checks every sha256,
writes rows to numbered SQL files of at most 50 MB under
`.restore/<backup_id>/` (tables in parent-before-child order; rows with a
missing parent go to `.restore/<backup_id>/orphans.json` instead), and
applies each file with `wrangler d1 execute DB --remote --file --config
<restore-config>`. Pass `--dry-run` to download and generate without
applying.

### Step 3 — verify (verify on staging in drill)

```bash
node scripts/verify-restore.mjs --prefix d1/YYYY/MM/DD/<backup_id>/ --config <restore-config>
```

Checks `PRAGMA integrity_check`, an empty `PRAGMA foreign_key_check`,
row counts equal to the manifest minus `orphans.json`, per-column BLOB
byte totals equal to the manifest minus orphaned BLOBs, and
`d1_migrations` equal to the manifest. Exit 1 on any difference —
do not proceed until every check passes.

### Step 4 — point a Worker at it and smoke-test (verify on staging in drill)

Change `database_id` in the config to the restored database, deploy, and
smoke-test:

```bash
pnpm exec wrangler deploy --config <restore-config>
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
