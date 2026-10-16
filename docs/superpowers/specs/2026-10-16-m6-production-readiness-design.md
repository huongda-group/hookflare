# M6 — Production readiness: Design Spec

> Milestone M6 of the [roadmap](2026-10-14-hookflare-roadmap.md). M0–M5 built every feature. M6 builds no new features. It answers four questions before real traffic arrives: how much load can one deployment take, how is data recovered after a mistake, how is a release shipped and undone, and who notices when the whole Worker is down.
>
> M6 is one spec delivered as **four PRs, in this order**: **M6a Staging, deploy & rollback** (§5), **M6b Benchmarks & queue tuning** (§6), **M6c Backup & restore** (§7), **M6d Monitoring, runbook & production rollout** (§8). Every PR adds its own runbook pages. M6d finishes the runbook and uses it to bring production up to date, which is the first real test of the runbook.

## 1. Goal and exit criteria

**Goal:** an operator who has never seen the code can deploy Hookflare, undo a bad release, restore D1 after data loss, and react to every alert, using only `docs/runbook/`. The limits of one deployment are measured, not guessed, and the shipped configuration matches the measurements.

**Exit criteria (roadmap M6, `DESIGN.md` §11 last item):**
1. The runbook, the migration procedure, backup/restore, and rollback exist, and each one has been run at least once on staging, with the result recorded (§7.5, §5.6).
2. Benchmark results and recommended limits are documented (§6.5), and `wrangler.jsonc` ships the recommended queue settings.
3. Production runs `main`, has an external uptime monitor, and has a verified backup (§8.4).

## 2. Scope

**In scope**
- **M6a:** a committed staging deployment; a sink Worker used as the backend for smoke tests and benchmarks; Access service-token identities for automation; a post-deploy smoke script; a deploy script that records a restore point; a migration safety check in CI; the deploy, migrations, and rollback pages of the runbook.
- **M6b:** a load generator and a dataset seeder; benchmark scenarios B1–B6 (§6.3) run on staging; a results document with recommended limits; queue settings tuned from the results.
- **M6c:** D1 Time Travel as the primary restore path; a daily `BackupWorkflow` that copies every D1 table to a dedicated R2 bucket; a `backups` table; the `backup_stale` alert rule; a restore-verification script; a restore drill on staging; the backup/restore page of the runbook.
- **M6d:** a job heartbeat reported by `/healthz`; the external uptime monitoring setup; the incident playbooks; the production rollout of `main`.

**Out of scope**
- Splitting ingress into its own Worker. The M5 spec listed it as M6; the roadmap keeps it in the backlog, and the roadmap wins. If B1 shows the single Worker cannot reach the DEC-2 target, the results document says so and recommends limits. M6 does not re-architect.
- Gradual (percentage) deployments. A release goes to 100% at once; undoing it is a rollback (§5.5).
- Continuous deployment from CI. Deploys stay manual through `pnpm run deploy`; CI only checks.
- Rotating `SECRETS_KEY` (backlog). M6 documents how to store it safely (§7.6).
- Backing up R2 objects (`events/…`, `archive/…`). R2 is the durable store for those; §7.6 explains what a D1 restore means for them.
- Restoring an archive into D1 (backlog, unchanged).

## 3. Decisions taken in this spec

| # | Topic | Decision | Why |
|---|---|---|---|
| M6-1 | Delivery order | Four PRs: Staging/deploy → Benchmarks → Backup → Monitoring/rollout. | Benchmarks and drills need staging, a sink, and the smoke script. The rollout needs every other part. |
| M6-2 | Staging | A second committed config, `apps/gateway/wrangler.staging.jsonc`: Worker `hookflare-staging`, D1 `hookflare-staging`, queues and buckets suffixed `-staging`. A CI test fails if the two configs differ in anything except names, IDs, `vars`, and `routes`. | DEC-1 and the M0 rule ("a separate copy of `wrangler.jsonc`"). The parity test stops staging from drifting into a different system than the one it is meant to test. |
| M6-3 | Where load runs | Benchmarks, drills, and destructive restores run **only on staging**. Production only gets the smoke test, read-only checks, and a non-destructive export drill. | Production holds real data; a Time Travel restore there loses writes. |
| M6-4 | Sink backend | A small Worker in `tools/sink` (`hookflare-sink`, on `workers.dev`). Its behavior comes from the URL: `/r/<run>/hook?status=<code>&delay_ms=<n>&fail_pct=<n>`. It records every `webhook-id` per run in SQLite-backed DOs (16 shards by hash of the ID) and serves `GET /r/<run>/stats`: received, unique, duplicates, status mix. | The SSRF guard blocks local backends (M4-13), so tests against a deployed gateway need a public HTTPS backend. Counting IDs on the backend is the only way to measure loss and duplicates end to end. |
| M6-5 | Load generator | A Node script in `tools/bench` with no new runtime dependencies (built-in `fetch`, the Node version in `.nvmrc`). It is **open-loop**: requests leave at a fixed arrival rate whether or not earlier ones have finished. It writes one JSON result file per run. | A closed-loop tool slows down when the server slows down and hides overload. One small script is easier to review than a k6 setup. |
| M6-6 | Automation identity | Cloudflare Access **service tokens** become admin identities. A service-token JWT has no `email`; the middleware uses `svc:<common_name>` instead. That identity must already exist in `users` (an admin adds it with a role); `BOOTSTRAP_ADMIN_EMAILS` never applies to it. The users API accepts the `svc:` form. No schema change. | The smoke test and the restore check need the admin API without a browser. Keeping service tokens inside `users` keeps RBAC and the audit log unchanged (DEC-5). |
| M6-7 | Smoke test | `pnpm smoke --config <wrangler config>`: create (or reuse) a smoke project/source/destination pointing at the sink → send one signed webhook → poll until `delivered` → replay it → poll until the replay is `delivered` → check the sink saw the same `webhook-id` twice. Exit code 0 or 1. | This is the roadmap §9 smoke test ("send a webhook → delivered → replay"). It runs after every deploy and in every drill. |
| M6-8 | Deploy script | `pnpm run deploy` becomes `scripts/deploy.mjs`: record the D1 Time Travel bookmark and the current Worker version → build → `migrate:remote` → `wrangler deploy` → smoke test → print the exact rollback and restore commands with the recorded values. A failed smoke test exits non-zero and prints the same commands; it does not roll back on its own. | The values an operator needs to undo a release are captured before the release changes anything. Undoing stays a human decision, because a rollback may be wrong when a migration already ran. |
| M6-9 | Migration safety | A CI script, `scripts/check-migrations.mjs`, fails when a migration that is not yet applied on `main` contains `DROP TABLE`, `DROP COLUMN`, `RENAME`, or adds a `NOT NULL` column without a default, unless the file is listed in `apps/gateway/migrations/contract.json` with the release that stopped using the old shape. | The M0 rule (expand → deploy → contract) is what makes rollback safe. Generated migrations cannot be hand-edited, so the exception list lives beside them. |
| M6-10 | Rollback | Rollback is `wrangler rollback <version-id>` to the version recorded by the deploy script. Migrations are never reversed. A release that changes the Durable Object `migrations` block or a Workflow class is **roll-forward only**, and its PR must say so. | Expand/contract keeps the old code working on the new schema. DO class migrations cannot be undone by deploying older code. |
| M6-11 | Primary restore | D1 **Time Travel** (point-in-time restore, 30 days on Workers Paid). | Built in, minute-level, nothing to run. It covers the common accidents: a bad migration, a bad bulk change, a bad release. |
| M6-12 | Second copy | A daily **table-by-table copy** made by an in-Worker `BackupWorkflow`: it pages through every table by primary key, 5,000 rows per step, and writes gzip NDJSON parts plus a `manifest.json` to a dedicated R2 bucket `hookflare-backups` under `d1/YYYY/MM/DD/<backup_id>/`. It does **not** use the D1 export API. | Time Travel lives inside the same database, so a deleted database, or an accident noticed after 30 days, needs a copy outside it. The D1 export API blocks every other request to the database while it runs, which would take ingress down every night. It would also need an account-wide API token in the Worker, and it stops at about 5 GiB (single R2 `put`, `wrangler d1 execute --file`). Small paged reads block nothing and need no token, and small parts have no size ceiling. The part writer reuses the M5c NDJSON/gzip helpers. |
| M6-13 | Backup schedule | A fourth cron, `0 20 * * *` (03:00 in Vietnam, UTC+7), starts the Workflow with instance ID `backup-YYYY-MM-DD`. | A full read of every table is still load, so it runs at the expected quietest hour (B6 measures the cost). The date-based ID dedupes cron runs, as in M5-16. |
| M6-14 | Backup record | Table `backups` (id, day, status `running`/`verified`/`failed`, prefix, part_count, row_counts_json, bytes, started_at, finished_at, error). The manifest lists every part with its table, row count, size, and sha256, plus the applied `d1_migrations` names. A backup is `verified` once every part's `HEAD` matches the manifest. Retention: `storage.backup_retention_days` (default 35); the Workflow deletes older prefixes and rows. | The dashboard and the alert need to know when the last good backup was. The manifest is what the restore script checks against. |
| M6-21 | Consistency | The copy is **not a point-in-time snapshot**: each part is consistent, but tables are read minutes apart. A restore from it (§7.4) skips rows whose parent row is missing and reports them. | It is the last-resort path, for a lost database. Point-in-time recovery is Time Travel's job (M6-11). |
| M6-22 | Outbound fetch | Both gateway configs add the compatibility flag `global_fetch_strictly_public`. | Without it, a `fetch()` from the gateway to another Worker on the same zone (the sink, or any team backend on `workers.dev` in this account) fails with error 1042. Destinations are meant to be reached as public internet hosts, which is what the flag does; the SSRF guard is unchanged. |
| M6-15 | Backup protection | `hookflare-backups` has an R2 bucket lock rule of 7 days. | A mistaken or malicious delete cannot remove the most recent backups. |
| M6-16 | `backup_stale` alert | New alert rule: no `verified` backup in the last 36 hours. Same incident and notification path as M5b. It is not evaluated while backups are off (M6-23), and an open incident resolves when they are turned off. | A broken backup is invisible until the day it is needed. Turning backups off is a deliberate admin choice, so it should not page anyone. |
| M6-23 | Backup switch | `storage.backup_enabled` (default **on**), a toggle in Settings › Storage. Off: the cron starts no Workflow (logs `backup.disabled`), retention stops too, so existing copies are kept, and "Run backup now" still works. The page shows a warning while it is off: only Time Travel (30 days) protects the data. Changing it is audited like every settings change. | Some deployments (staging, a fork, a small team) do not want the extra R2 storage or the nightly read. Keeping existing copies when off means turning it off never deletes anything. |
| M6-17 | Job heartbeat | Each scheduled run writes its finish time to the `settings` key `jobs.heartbeat` (`reconcile_at`, `alerts_at`, `rollup_at`, `backup_at`). `/healthz` returns `503 {"status":"degraded","reason":"jobs_stale"}` when `reconcile_at` is older than 5 minutes. | The alerts job runs inside the Worker, so it cannot report that cron itself stopped. The external monitor can. |
| M6-18 | Uptime monitoring | Provider-agnostic. Required checks (§8.2): `/healthz` every minute from at least two regions, an ingress probe that expects `401`, and a dashboard probe that expects the Access redirect. The monitor posts to the same Discord/Slack channel as the M5 alerts. | The checks matter, not the vendor. The runbook gives one worked example. |
| M6-19 | Queue tuning | `max_concurrency`, `max_batch_size`, `max_batch_timeout`, and `retry_delay` are set explicitly in both configs from the B3 results. The DLQ consumer is configured explicitly too. | The roadmap §7.2 says "tuned after benchmarking". Leaving `max_concurrency` unset lets the consumer scale to the platform maximum and compete with ingress for D1's single writer. |
| M6-20 | Production rollout | M6d's last step brings production from its current state to `main` by following the runbook, and records the run in `docs/runbook/drills/`. | Production today (checked through the Cloudflare API on 2026-10-16): Worker version from 2026-10-15 07:25 UTC (M1 era), served only on `workers.dev`; D1 already at migration `0009_archive`, with 0 events; main queue with `max_retries: 10`; no DLQ queue, no `hookflare-payloads` bucket, no Workflows. A real, empty upgrade is the safest first run of the runbook. |

### 3.1 Deviations from the roadmap and earlier milestones

| Source | Change | Reason |
|---|---|---|
| M5 spec §2 "Splitting ingress into its own Worker (M6)" | Stays in the backlog | Roadmap §10 lists it in the backlog; the roadmap wins |
| Roadmap §7.3 cron list | Adds `0 20 * * *` for the backup | M6-13 |
| Roadmap §7.3 alert rules | Adds `backup_stale` | M6-16 |
| DEC-5 "keyed by the email from the Access JWT" | Also accepts `svc:<common_name>` for Access service tokens | M6-6 |
| M0 §7 `/healthz` checks D1 only | Also checks the job heartbeat | M6-17 |
| M0 `pnpm run deploy` = build, migrate, deploy | Now also records restore points and runs the smoke test | M6-8 |
| Roadmap M6 "scheduled exports" | A table-by-table copy to R2 instead of the D1 export API | M6-12: the export API blocks the database while it runs |
| M0 compatibility flags (`nodejs_compat` only) | Adds `global_fetch_strictly_public` | M6-22 |
| Roadmap §5.1 parity test (`apps/gateway/test/config-parity.test.ts`, Vitest) | Lives in `scripts/test/config-parity.test.mjs` (node:test); `preview_database_id` added to the ignored keys | Scripts are plain node, not gateway code; the staging database needs a preview ID the prod config lacks |
| Roadmap §7.1 "5,000 rows per step" for every table | BLOB-bearing tables page at 250 rows per step (`BLOB_PAGE_SIZE` in `jobs/backup/tables.ts`) | A 5,000-row BLOB page would blow the per-step read budget; small BLOB pages keep the nightly read cheap |
| Roadmap §7.4 hardcoded restore order (projects, destinations, sources, …) | `tableOrder` in `scripts/lib/restore-sql.mjs` sorts tables topologically from the manifest's foreign keys (self-references ignored; forward self-references pre-collected) | Schema changes must not require a restore-script change; the manifest already carries the FK graph |
| Roadmap §7.4 "turns rows into `INSERT` statements" | Rows whose `INSERT` would exceed 90 k chars become `INSERT` with empty BLOBs plus chunked `UPDATE … SET c = CAST(c \|\| X'…' AS BLOB)` appends (32 KiB of bytes per chunk) | D1 rejects oversized statements; chunked appends keep large payloads restorable |
| Roadmap §7.4 verify (integrity, row counts, migrations) | `verify-restore.mjs` also checks per-column BLOB byte totals against the manifest minus orphaned BLOBs | Row counts alone cannot catch a truncated payload; the manifest already records `blob_bytes` |
| Roadmap §9 "scripts are exercised by the drills, not by CI" | `scripts/test/fixtures/` holds checked-in `time-travel-info.json` and `deployments-list.json`; the staging names in the deploy tests come from those fixtures | Drills still exercise the scripts end to end; fixtures let CI cover the parsing and decision logic without live wrangler output |

## 4. Repository layout

```text
apps/gateway/
├── wrangler.staging.jsonc            # M6a
├── migrations/contract.json          # M6a: destructive migrations allowed, with the release
└── src/jobs/backup/                  # M6c: workflow.ts, dump.ts (paged table reader), manifest.ts, retention.ts
tools/
├── sink/                             # M6a: sink Worker (own wrangler.jsonc, own tests)
└── bench/                            # M6b: load generator, seeder, scenario files
scripts/
├── deploy.mjs                        # M6a
├── smoke.mjs                         # M6a
├── check-migrations.mjs              # M6a
├── restore-backup.mjs                # M6c
└── verify-restore.mjs                # M6c
docs/
├── benchmarks/2026-10-XX-m6-results.md   # M6b
└── runbook/
    ├── README.md                     # index, who to call, glossary
    ├── setup.md                      # new deployment from zero (moves out of README)
    ├── deploy.md · migrations.md · rollback.md        # M6a
    ├── backup-restore.md · secrets.md                 # M6c
    ├── monitoring.md · incidents.md                   # M6d
    └── drills/YYYY-MM-DD-<drill>.md                   # every recorded drill
```

`tools/*` are pnpm workspaces so `pnpm test`, `pnpm typecheck`, and `pnpm lint` cover them. Neither is imported by `apps/gateway`.

## 5. M6a — Staging, deploy & rollback

### 5.1 Staging deployment

- `wrangler.staging.jsonc` is a copy of `wrangler.jsonc` with its own names and IDs (M6-2). Its `vars` point at a staging Access application.
- `package.json` adds `deploy:staging`, `db:migrate:remote:staging`, and `smoke:staging`, which pass `--config apps/gateway/wrangler.staging.jsonc`.
- The parity test lives in `apps/gateway/test/config-parity.test.ts`. It parses both JSONC files and compares them after removing an allowlist of keys (`name`, `database_name`, `database_id`, `queue`, `dead_letter_queue`, `bucket_name`, workflow `name`, `vars`, `routes`).

### 5.2 Sink Worker (`tools/sink`)

- `POST /r/<run>/hook`: reads `status` (default 200), `delay_ms` (default 0, max 30,000), and `fail_pct` (default 0; that share of requests returns 503 instead of `status`). Records `webhook-id`, the response it chose, and the time, then responds.
- `GET /r/<run>/stats`: merges the 16 shards: `received`, `unique`, `duplicates`, counts by status, and the first and last receive time.
- `DELETE /r/<run>`: clears a run.
- It does not verify signatures; the gateway's signing is covered by M1 tests. It has no auth, so a run ID must be random (the bench and smoke scripts use a ULID). Stored data expires after 7 days through a DO alarm.

### 5.3 Service-token identity

In `admin/auth/access.ts`: after the JWT is verified, if `payload.email` is missing and `payload.common_name` is a string, the identity is `svc:<common_name>`. Lookup in `users` is unchanged. A missing or disabled `svc:` user gets `403`, as any unknown email does. The users API (create and update) accepts `email` that is either an email address or `svc:` followed by the Access client ID. The dashboard Users page shows these rows with a "service token" badge. Tests: a JWT with `common_name` only → identity; bootstrap never creates a `svc:` user; audit rows carry `svc:…` as `actor_email`.

### 5.4 Smoke and deploy scripts

- `scripts/smoke.mjs` (M6-7) reads `HOOKFLARE_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, and `SINK_URL` from the environment. It reuses a project with slug `smoke` if one exists. Polling waits at most 60 s per step. It prints each step and the IDs it used.
- `scripts/deploy.mjs` (M6-8) takes `--config`. Before migrating it runs `wrangler d1 time-travel info` and `wrangler deployments list` and writes both values to the console and to `.deploy/<timestamp>.json` (git-ignored). The smoke step is skipped, with a warning, when the smoke environment variables are missing, so a first-time deployment still works.

### 5.5 Migrations and rollback

- `scripts/check-migrations.mjs` (M6-9) runs in CI after the drift check. "Not yet applied on `main`" means the file is new compared with `origin/main`.
- `docs/runbook/migrations.md`: the expand → deploy → contract sequence with a worked example (renaming a column across three releases); how to write a data migration like `0003`; how to check pending migrations (`wrangler d1 migrations list --remote`).
- `docs/runbook/rollback.md`: decide (§5.6 table) → `wrangler rollback <version>` → smoke → note in the incident. It lists what a rollback does **not** undo: D1 schema and data, R2 objects, queue messages already sent, DO migrations, settings changed through the API.

### 5.6 Rollback decision table (goes into `rollback.md`)

| Situation | Action |
|---|---|
| New code is broken; its migrations were expand-only | Roll back the Worker |
| New code is broken; the release has a contract migration or DO migration | Roll forward with a fix |
| A migration or bulk change corrupted data, noticed within 30 days | Time Travel restore (§7.3), then roll back the Worker if needed |
| The database is gone or the problem is older than 30 days | Restore the latest R2 copy into a new database (§7.4) |

**Drill (M6a exit):** on staging, deploy a version, deploy a deliberately broken version (ingress returns 500), detect it with the smoke test, roll back, smoke again. Record the times in `drills/`.

## 6. M6b — Benchmarks & queue tuning

### 6.1 Targets (from DEC-2)

| Metric | Target |
|---|---|
| Sustained ingress | 100 req/s for 10 minutes, < 0.1% `5xx`, p99 < 1 s at the client |
| Delivery drain | ≥ 100 deliveries/s to a 100 ms sink with ingress at 50 req/s at the same time |
| Loss | Every `202` reaches the sink at least once (sink `unique` = count of `202`) |
| Duplicates | < 0.5% at the sink under normal conditions |

Missing a target is a result, not a failure of M6: the results document records the real number and the limits that follow from it.

### 6.2 Tooling

- `tools/bench/run.ts <scenario.json>`: open-loop load at the scenario's rate steps; it spreads requests over N sources, signs each one with HMAC, and records per-request status and latency. At the end it waits for the queue to drain (polls the admin API stats until no `pending`/`queued`/`retrying` remain, or a timeout) and fetches the sink stats.
- `tools/bench/seed.ts`: generates a D1 dataset of N events with a realistic mix (payload size distribution, 1–3 attempts per delivery, a few percent `failed_final`/`dead`) as SQL files and loads them with `wrangler d1 execute --file --remote` against staging. Used for B5, where driving 1M events through ingress would take hours.
- Every run writes `tools/bench/results/<scenario>-<timestamp>.json` (git-ignored); the summary goes into the results document.

### 6.3 Scenarios (all on staging)

| ID | What it measures | Setup |
|---|---|---|
| B1 | Ingress throughput and D1 write limits | Steps of 25 → 50 → 100 → 200 → 400 req/s, 3 min each, 1 KB bodies, 40 sources (each below the 10 req/s per-source limiter). Repeat the 50 req/s step with 100 KB bodies (R2 path). Record status mix, latency percentiles, and D1 "overloaded" errors in the Worker logs. |
| B2 | Per-source limiter | One source at 50 req/s for 1 min. Confirms the `429` share and that `429` requests write nothing. Feeds the recommended `INGRESS_LIMITER` value. |
| B3 | Consumer concurrency | Pause a destination, ingest 50,000 events, resume, and measure drain rate and ingress latency (ingress at 50 req/s during the drain). Repeat with `max_concurrency` unset, 5, 10, 20, and with sink delays of 100 ms and 1 s. |
| B4 | Retry storm | Sink `fail_pct=30` for 10 minutes at 50 req/s, then healthy. Measures backlog growth, reconciler load, and recovery time. |
| B5 | D1 size and query cost | Seed 1M events, then measure bytes per event from `meta.size_after`, and the latency of: the events list with sparse filters (M3 risk), the failures views, the overview, the rollup run (M4 risk), and one archive run (M5c). Repeat the size measurement for 10% inline payloads above 32 KB. |
| B6 | Backup cost | With 1M events seeded and ingress at 50 req/s, start a `BackupWorkflow` run. Record ingress latency during the run, its total duration, its step count, rows read, and the R2 size. Runs after M6c lands. |

### 6.4 Applying the results

M6b ends by setting the tuned queue values (M6-19) in both configs, and by adjusting `INGRESS_LIMITER` if B2 shows the current 100 per 10 s is wrong for the expected providers. Code changes beyond configuration (for example a lower inline threshold) are proposed in the results document and only implemented if they are small; anything larger becomes a backlog item.

### 6.5 Results document

`docs/benchmarks/2026-10-XX-m6-results.md` contains: the date, the Worker version, and the Cloudflare plan; one section per scenario with the raw numbers; a **D1 size model** table (events/day 50k, 250k, 1M × `hot_retention_days` 7, 14, 30 → estimated GB, with the 10 GB limit marked); and a **recommended limits** table: maximum sustained ingress, `INGRESS_LIMITER`, queue settings, `hot_retention_days` per daily volume, `d1_warn_pct`, and the backup hour. The README links to it.

## 7. M6c — Backup & restore

### 7.1 BackupWorkflow

Started by the `0 20 * * *` cron (M6-13) with instance ID `backup-YYYY-MM-DD`, only when `backup_enabled` is on (M6-23); "Run backup now" in Settings › Storage starts `backup-YYYY-MM-DD-manual-<n>`. The steps are plain functions that take `Deps`, as in M5c:

1. **start**: insert a `backups` row (`running`) with prefix `d1/YYYY/MM/DD/<backup_id>/`; read the table list from `sqlite_schema` (excluding `sqlite_*`, `_cf_*`, and `d1_migrations`, which goes into the manifest instead).
2. **dump** (one step per part): `SELECT * FROM <table> WHERE <pk> > :cursor ORDER BY <pk> LIMIT 5000`; BLOB columns are base64-encoded; write `<table>/part-NNNN.ndjson.gz` with one `put` that passes `sha256` (as M5-19); the step's result is the next cursor and the part's metadata. Tables without a single-column primary key are paged by `rowid`.
3. **manifest**: write `manifest.json` (tables, parts, row counts, sizes, sha256, `d1_migrations`, start and finish time).
4. **verify**: `HEAD` every part and the manifest; all match → `verified`; otherwise → `failed` with the first mismatch.
5. **retention**: delete prefixes and rows older than `backup_retention_days`, never the newest `verified` one.

Any step failing after its retries marks the row `failed`. The run respects the M5-22 step budget: a database too large for one instance continues in `backup-YYYY-MM-DD-cont-<n>` from the last cursor, and stays `running` until done.

### 7.2 Settings and UI

`storage` settings gain `backup_enabled` (default on, M6-23) and `backup_retention_days` (default 35, 7–365). Settings › Storage shows the backup toggle (with the Time Travel warning while it is off), the last verified backup (time, size, rows), the last failure if newer, and "Run backup now" (admin only, audited as `backup.run`). There is no download button: restoring is an operator task done with scripts, not through the dashboard.

### 7.3 Restore path A: Time Travel (in place)

`backup-restore.md` documents it step by step: pick the timestamp (or the bookmark from the deploy record) → pause every destination if deliveries should not run against the old state → `wrangler d1 time-travel restore` → keep the "undo" bookmark it prints → smoke → resume. It warns, in bold, that every write after the restore point is lost, including webhooks already acknowledged with `202`, and that providers will not resend them. Use it only when that loss is smaller than the damage being undone.

### 7.4 Restore path B: R2 copy into a new database

1. `wrangler d1 create hookflare-restore-<date>`, then apply the repository migrations to it up to the last name in the manifest's `d1_migrations`.
2. `scripts/restore-backup.mjs --prefix <prefix> --config <config>` downloads the manifest and parts, checks every sha256, turns rows into `INSERT` statements in files of at most 50 MB, and runs them with `wrangler d1 execute --remote --file`, parent tables first (projects, destinations, sources, webhook_events, deliveries, delivery_attempts, then the rest). Rows whose parent is missing (M6-21) are written to an orphans report instead of the database.
3. `scripts/verify-restore.mjs`: `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, row counts equal to the manifest minus the orphans report, and `d1_migrations` equal to the manifest.
4. Change `database_id` in the config → deploy → smoke.

### 7.5 Restore drill (M6c exit)

On staging, with B5's seeded data:
1. Path A: record a bookmark, delete one project's events through SQL, restore to the bookmark, verify counts, smoke.
2. Path B: restore the latest R2 copy into a new database with `restore-backup.mjs`, run `verify-restore.mjs`, point a scratch Worker (`hookflare-restore-drill`) at it, smoke, delete the scratch resources.
3. Record wall-clock time for each path (the RTO) and the data window lost (the RPO) in `drills/YYYY-MM-DD-restore.md`.

On production, only path B is drilled, into a scratch database, and the scratch database is deleted afterwards. The runbook asks for a repeat every quarter.

### 7.6 Secrets and R2 (`secrets.md`, part of `backup-restore.md`)

- **`SECRETS_KEY` is the one thing a backup cannot replace.** Without it every source secret, signing secret, and channel config in a restored database is unreadable. The runbook requires it to be kept in the team password manager, with who has access, and lists the secrets to re-enter on a new deployment (`SECRETS_KEY`).
- A D1 restore does not touch R2. After path A, events whose payload objects were purged after the restore point come back with a missing payload; delivery and replay already handle that as `payload_missing`. Archive batches written after the restore point stay in R2 and are not listed; the runbook says how to find them by prefix.
- Leaked secrets: rotate through the API; the inbound source cache keeps accepting a rotated secret for up to 30 s (M3 risk), which the runbook states.

## 8. M6d — Monitoring, runbook & production rollout

### 8.1 Job heartbeat

`runScheduled` writes `jobs.heartbeat` after each job finishes (one `UPDATE` per job run; the reconciler and alerts jobs run every minute). `/healthz` reads it in the same probe as `SELECT 1`. A missing row exists only on a fresh database before the first cron run; it counts as healthy and the response says `"jobs": "unknown"`. Otherwise the response adds `"jobs": {"reconcile_at": …}`. (`CF_VERSION_METADATA.timestamp` is the upload time, not the deploy time, so it cannot anchor a grace period after a rollback.)

### 8.2 External checks (`monitoring.md`)

| Check | Request | Expect | Interval |
|---|---|---|---|
| Health | `GET /healthz` | `200` and `"status":"ok"` | 1 min, ≥ 2 regions |
| Ingress | `POST /in/<canary source id>` with a wrong signature | `401` | 5 min |
| Dashboard | `GET /` without a session | `302` to the Access login | 15 min |

The canary source is an `hmac` source whose destination is the sink; it never stores anything because every probe fails verification. Two consecutive failures page the channel. The runbook gives one worked setup for a free uptime service and lists the alternatives; picking one is an account decision for the team.

### 8.3 Incident playbooks (`incidents.md`)

One section per signal, each with **symptom → check → act → close**: every M5 alert rule (`consecutive_failures`, `new_dead`, `stuck_pending`, `d1_storage`, `archive_stuck`) and `backup_stale`; health check down; ingress `5xx` spike; queue backlog growing; D1 "overloaded"; a leaked source or destination secret; a lockout from the dashboard (Access misconfigured or no admin left; recovery through `BOOTSTRAP_ADMIN_EMAILS`); a Cloudflare platform incident (providers retry; what to check afterwards). Each playbook names the exact dashboard page, API call, or wrangler command.

### 8.4 Production rollout (M6d exit)

Following `setup.md` and `deploy.md` only, on the production account:
1. Create the missing resources: the DLQ queue, the `hookflare-payloads` bucket, and `hookflare-backups` with its lock rule. `wrangler deploy` fails on the `PAYLOADS` binding until the bucket exists.
2. Attach the production hostname (a custom domain chosen at rollout) and set `PUBLIC_BASE_URL` to it. Confirm the Access application, its bypass for `/in/*` and `/healthz`, and a service token added to `users` as operator.
3. `pnpm run deploy`; the smoke test passes against the sink.
4. Configure the M5 alert channel and the external checks; trigger one test alert.
5. Run a manual backup; it reaches `verified`. Run the production export drill (§7.5).
6. Record every step, every surprise, and every runbook fix in `drills/YYYY-MM-DD-production-rollout.md`.

Any step that needs knowledge not in the runbook is a runbook bug and gets fixed in the same PR.

## 9. Testing

- **Unit/integration (Vitest):** config parity (§5.1); service-token identity (§5.3); `check-migrations` on fixtures (allowed, blocked, allowlisted); `BackupWorkflow` steps against real D1 and R2 in Miniflare (paging across parts, BLOB round trip, a table paged by `rowid`, a sha256 mismatch, a continued run); `restore-backup.mjs` row-to-SQL conversion and orphan handling; retention keeps the newest verified backup; `backup_stale` open and resolve, and its silence while backups are off; the cron skipping the Workflow when `backup_enabled` is off; heartbeat writes and `/healthz` stale, fresh, and new-deployment cases; the sink's routing and stats merge.
- **Scripts:** `smoke.mjs` and `deploy.mjs` are exercised by the drills, not by CI; their argument parsing and decision logic are split into functions with unit tests.
- **Manual, recorded:** the rollback drill (§5.6), benchmarks B1–B6 (§6), the restore drill (§7.5), and the production rollout (§8.4). Each record has the date, the versions, the commands run, and the outcome.

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| The daily full read competes with ingress for D1 | Higher ingress latency during the backup | Small paged reads; the quietest hour (M6-13); B6 measures it, and the results document recommends a different hour or a lower frequency if needed |
| The R2 copy is not a point-in-time snapshot | A path B restore drops some recent child rows | Orphans are reported, not silently lost (M6-21); Time Travel stays the primary path |
| Staging shares the production account with other projects | Benchmarks hit account-wide limits | Benchmarks run in short steps and stop on the first sign of account-level errors; a dedicated account is a backlog option |
| Benchmarks cost money (D1 writes, Queues operations) | A surprise bill | The results document starts with a cost estimate per scenario; B5 seeds through SQL files instead of ingress |
| Staging drifts from production | Results that do not apply | Config parity test (M6-2); staging is redeployed from `main` before each benchmark run |
| The single Worker misses the DEC-2 target | Limits lower than planned | Documented as a result; ingress split stays a backlog item with the numbers attached |
| Quarterly drills are forgotten | Restore fails when needed | `backup_stale` covers the daily backup; the runbook index lists the last drill date at the top |

## 11. Left to the implementer

- The exact sink shard count and DO alarm schedule, if 16 shards or 7 days turn out wrong under B1.
- Scenario file format for `tools/bench`.
- The free uptime service used in the worked example.
- Wording and ordering inside each runbook page, as long as every playbook follows symptom → check → act → close.
