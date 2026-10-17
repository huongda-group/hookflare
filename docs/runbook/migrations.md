# Migrations

D1 schema changes only ever move forward — there is no down-migration.
Rollback safety comes from the **expand → deploy → contract** sequence plus
the CI check described below.

## The rule

1. **Expand** — a migration only *adds* (new column/table, nullable or with
   a default). Old code keeps working.
2. **Deploy** — ship code that reads/writes *both* shapes.
3. **Contract** — in a *later* release, once nothing uses the old shape,
   remove it. The removal migration must be listed in `contract.json`
   (see below), or CI fails.

A migration like `0003_collapse_duplicate_event_ids.sql` is the model for a
data migration: a plain `UPDATE` that reshapes rows in place (it nulls out
duplicate provider event IDs, keeping the earliest per group) so a later
`UNIQUE` index can be built. No rows are deleted.

## Worked example: renaming a column across three releases

Suppose `destinations.url` must become `destinations.target_url`.

**Release N (expand)** — `0010_add_target_url.sql`:

```sql
ALTER TABLE destinations ADD COLUMN target_url TEXT;
```

Code in release N writes both `url` and `target_url`, and reads
`target_url` with fallback to `url`.

**Release N+1 (deploy)** — backfill + dual use. A data migration copies
remaining rows, then code stops writing `url`:

```sql
UPDATE destinations SET target_url = url WHERE target_url IS NULL AND url IS NOT NULL;
```

**Release N+2 (contract)** — `0012_drop_url.sql`:

```sql
ALTER TABLE destinations DROP COLUMN url;
```

(Actual SQLite syntax depends on the D1 version; keep the migration
additive-safe and test it locally first.)

Because each intermediate schema works with both the old and the new code,
rolling the Worker back at any point leaves a working system. A release
that contains a **contract** migration is roll-forward only (see
[rollback.md](rollback.md#decision-table)).

## `contract.json`

`apps/gateway/migrations/contract.json` lists migration files that remove
an old shape, with the release that stopped using it:

```json
[
  { "file": "0012_drop_url.sql", "release": "v0.9.0", "reason": "destinations.url replaced by url_v2 in v0.9.0" }
]
```

Every entry needs non-empty `file`, `release`, and `reason` strings; the CI
check fails on a malformed file. (The current file is `[]` — no contract
migration has shipped yet.)

## CI check

`scripts/check-migrations.mjs` (runs in CI after the drift check) compares
migration files against `origin/main`. A migration that is new compared
with `origin/main` fails CI when it contains `DROP TABLE`, `DROP COLUMN`,
`RENAME`, or adds a `NOT NULL` column without a default — unless the file
is listed in `contract.json` with the release that stopped using the old
shape. It also fails when a migration that is already on `origin/main` was
modified or removed (D1 records applied migrations by name, so an edited
file never runs remotely; add a new migration instead). Invoke it as:

```bash
node scripts/check-migrations.mjs --base origin/main
```

Generated migrations cannot be hand-edited, so the exception list lives
beside them in `contract.json`.

## Checking pending migrations (verify on staging in drill)

```bash
pnpm exec wrangler d1 migrations list --remote --config apps/gateway/wrangler.staging.jsonc
```

Apply with `pnpm db:migrate:remote:staging` (staging) or
`pnpm db:migrate:remote` (production) — normally you do not run these
directly; `scripts/deploy.mjs` migrates as part of every deploy.
