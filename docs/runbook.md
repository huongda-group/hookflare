# Operations runbook

[Documentation index](README.md). Commands run from the repository root using the pinned tools after `pnpm install`. Read only the section needed for the operation.

**Verification status:** live staging setup, rollback, restore, and monitoring drills remain pending. All remote procedures below are **verify on staging in drill**; this document is not evidence of a deployment or successful recovery. Record results under [Drills](#drills).

## Target environment

| Environment | Config | Deploy | Smoke URL variable |
| --- | --- | --- | --- |
| Staging | `apps/gateway/wrangler.staging.jsonc` | `pnpm deploy:staging` | `HOOKFLARE_STAGING_URL` |
| Production | `apps/gateway/wrangler.jsonc` | `pnpm run deploy` | `HOOKFLARE_URL` |

In commands below, replace `<config>`, `<db-name>`, `<backup-prefix>`, and `<version>` with values for the intended environment. Staging and production must use separate D1, queues, buckets, and secrets. Inspect the config before a remote mutation; do not deploy the all-zero staging database ID.

## Setup

1. Install dependencies and authenticate Wrangler to the intended account. Create resources named in the selected config. For staging:

   ```bash
   pnpm exec wrangler d1 create hookflare-staging --config apps/gateway/wrangler.staging.jsonc
   pnpm exec wrangler queues create hookflare-deliveries-staging
   pnpm exec wrangler queues create hookflare-deliveries-dlq-staging
   pnpm exec wrangler r2 bucket create hookflare-payloads-staging
   pnpm exec wrangler r2 bucket create hookflare-backups-staging
   ```

2. Put the returned D1 ID in the config. Check `DB`, `QUEUE`, `PAYLOADS`, `BACKUPS`, Durable Object/Workflow bindings, cron triggers, and distinct rate-limit namespaces. Set `PUBLIC_BASE_URL` if the ingress origin needs an explicit value. Configure backup bucket protection deliberately; do not assume a bucket lock exists merely because the bucket exists.
3. Generate a 32-byte base64 encryption key (`openssl rand -base64 32`), retain it in the team's password manager, and set secrets interactively:

   ```bash
   pnpm exec wrangler secret put SECRETS_KEY --config <config>
   pnpm exec wrangler secret put SETUP_TOKEN --config <config>
   ```

   Set a Turnstile widget's public `TURNSTILE_SITE_KEY` in config and its `TURNSTILE_SECRET_KEY` through `wrangler secret put`. Both set means enforced; neither means off; one alone fails closed. Local development uses `apps/gateway/.dev.vars.example`, never committed real credentials.
4. Deploy the sink: `pnpm --filter sink run deploy`. First gateway deploy: `node scripts/deploy.mjs --config <config> --skip-smoke`. If the restore-point step fails on an empty environment, stop and inspect it; do not claim deployment succeeded or bypass it silently.
5. Open the Worker URL and claim the first admin with `SETUP_TOKEN`. Create an admin API token for smoke automation in Settings → Users. Store it securely, export it as `HOOKFLARE_API_TOKEN`, set `SINK_URL` and the environment's smoke URL variable, then run smoke. The setup token is unused after onboarding and can be removed.

See [login](login.md), [API tokens](api-tokens.md), and the [root quick start](../README.md) for account and first-webhook details.

## Deploy and smoke

```bash
pnpm deploy:staging
pnpm smoke:staging
# Production equivalents:
pnpm run deploy
pnpm run smoke
```

The deploy script runs **restore-point record → build → migrate → deploy → smoke**. Missing smoke environment stops it before changes unless `--skip-smoke` is explicit. A gradual version split must be resolved before recording a single rollback target. Git-connected builds that skip smoke still need a separate smoke run afterward.

Keep `.deploy/<timestamp>.json`: it records the previous/new Worker versions, D1 bookmark, smoke result, and manual rollback commands. The script prints recovery commands but never executes them automatically. A failure before migration/deployment starts has nothing from those steps to undo.

Smoke creates/reuses the dedicated `smoke` project, source, and destination, rotates its source secret, sends one signed event, replays it, and verifies both deliveries at the sink. Success is exit 0 with one event ID and two delivery IDs. Use the correct URL variable from the table; the origin must match the selected config. Smoke changes its dedicated resources, so do not use them for business traffic.

## Migrations

Use **expand → deploy compatible code → contract in a later release**. Generate migrations through `pnpm db:generate`; never edit applied/generated migrations in place. Add destructive migration declarations to `apps/gateway/migrations/contract.json`, with file, release, and reason.

```bash
node scripts/check-migrations.mjs --base origin/main
pnpm exec wrangler d1 migrations list --remote --config <config>
```

Normally the deploy script applies migrations. A contract migration, Durable Object migration, or incompatible Workflow-class change can make old code unusable: [roll forward](#rollback) instead of assuming Worker rollback is safe. The auth migration renames email identity columns to username/actor; a 1.x Worker cannot use that migrated admin schema.

The 1.0.0 baseline squash only fits databases that did not apply the removed pre-release files. Do not apply it over those tables or squash a database with real data without a separate migration/recovery plan. Current files: [migrations](../apps/gateway/migrations), [migration checker](../scripts/check-migrations.mjs).

## Rollback

| Situation | Recovery |
| --- | --- |
| Bad code, only backward-compatible expand migrations | Roll back Worker to `previousVersion` |
| Contract/DO/incompatible Workflow change | Roll forward with a fix |
| Corrupted data with an available Time Travel restore point | Evaluate write loss, then restore D1 and compatible code |
| Database lost or no suitable Time Travel point | Restore a verified R2 backup into a new database |

```bash
pnpm exec wrangler rollback <version> --config <config>
```

Use the previous version from the deploy record, then smoke-test the same environment. Worker rollback does **not** undo D1 changes, R2 objects, queue messages, DO migrations, or settings. Returning from the auth contract migration to 1.x requires restoring the pre-migration database as well, losing later writes. Record the decision and outcome; a failed smoke is an unresolved incident.

## Backup and restore

Backup runs daily at 20:00 UTC while enabled; default retention is 35 days. Inspect Settings → Storage or `GET /api/admin/v1/backups/summary`; start a manual run with `POST /api/admin/v1/backups/run`. Only one run may be active. Turning the setting off does not stop an active workflow; termination is a separate Workflows action. Only verified backups are recovery candidates, not `expiring` or partial copies.

### Path A: Time Travel

**Restoring loses every write after the restore point, including webhooks already acknowledged with 202.** Confirm the available restore window/bookmark for the actual database and accept the loss before proceeding.

1. Read the deploy bookmark or inspect available state:

   ```bash
   pnpm exec wrangler d1 time-travel info <db-name> --json --config <config>
   ```

2. Control ingress and delivery activity for the recovery window. Pausing destinations alone does not stop intake, and restoring D1 can also restore earlier pause/settings state.
3. Restore and retain the printed undo bookmark:

   ```bash
   pnpm exec wrangler d1 time-travel restore <db-name> --bookmark=<bookmark> --config <config>
   ```

4. Deploy/roll back to compatible Worker code if needed. Verify restored data, run smoke, reconcile secrets and queue activity, then resume traffic deliberately.

### Path B: R2 backup into a new database

The export is **not a point-in-time snapshot**. Missing-parent rows are skipped and reported in `.restore/<backup_id>/orphans.json`; verification is required before cutover.

1. Select a verified backup prefix `d1/YYYY/MM/DD/<backup_id>/` and bucket (`hookflare-backups-staging` or `hookflare-backups`). Create a fresh scratch D1 database. Copy the gateway config beside the original as an uncommitted restore config; set the new database ID/name and a distinct scratch Worker name. Isolate scratch queues, workflows, and other write-capable bindings before deploying it.
2. Prepare exactly the manifest's migrations, not the checkout's entire migration set:

   ```bash
   node scripts/restore-backup.mjs --prefix <backup-prefix> --bucket <backup-bucket> --prepare-migrations
   ```

   Set the restore config's `migrations_dir` to the printed path. If required files are missing, obtain the matching release's migrations before continuing.
3. Apply, restore, and verify:

   ```bash
   pnpm exec wrangler d1 migrations apply DB --remote --config <restore-config>
   node scripts/restore-backup.mjs --prefix <backup-prefix> --bucket <backup-bucket> --config <restore-config>
   node scripts/verify-restore.mjs --prefix <backup-prefix> --config <restore-config>
   ```

   The restore script rejects production targets, known staging targets without an explicit override, non-empty new targets, and mismatched migrations. A scratch drill needs no override. `--dry-run` generates SQL without applying. Interrupted imports resume using `applied.json` for the same database and file hashes; a partial import with uniqueness errors should be restarted in a fresh database. Review orphan counts; verification checks integrity, foreign keys, counts, BLOB totals, and migration parity. Do not proceed on failure.
4. Deploy the isolated scratch Worker and smoke against its own config: `node scripts/smoke.mjs --config <restore-config>`. Its URL variable derives from the Worker name (for example `HOOKFLARE_RESTORE_DRILL_URL`); set matching origin, API token, and sink URL. Do not use `pnpm smoke:staging` to claim the scratch Worker was tested.
5. Cut over only after verification and traffic coordination. Retain rollback material until acceptance; remove scratch resources after the drill.

Neither restore path restores R2 payloads or Worker secrets. Missing payload objects remain `payload_missing`; post-bookmark archives may remain in R2 but disappear from D1 listings. Reconcile them separately. Restored encrypted configuration works with its matching [encryption key](#secrets); source/destination secrets need rotation only when absent, compromised, or reverted to an obsolete value.

## Secrets

- Keep `SECRETS_KEY` outside the database backup in the password manager. Losing it makes encrypted source/destination/channel configuration unreadable. `HOOKFLARE_API_TOKEN` belongs on the automation runner, not in Worker vars or docs.
- Rotate exposed source/destination secrets through their dashboard actions or `POST /api/admin/v1/{sources|destinations}/:id/rotate-secret`. Update the provider/backend, account for the selected grace period and the 30-second source cache, and verify old credentials are rejected afterward.
- For encryption-key rotation, retain the old key as `SECRETS_KEY_PREVIOUS` while re-encrypting/re-entering stored configuration under the new key. Remove the previous key only after old ciphertext is no longer needed.
- A restore may revive old credentials, sessions, or token state. Revoke/re-rotate as necessary and verify access after recovery. Never put secret values in drill records.

## Monitoring

| Probe | Expected | Target interval |
| --- | --- | --- |
| `GET /healthz` | 200, `status: ok` | 1 minute, at least two regions |
| `POST /in/<canary-source>` with wrong HMAC | 401 | 5 minutes |
| `GET /login` | 200 | 15 minutes |

Use a dedicated HMAC canary source pointing to the sink; the invalid signature must not create an event. Notify after two consecutive failures, and record actual intervals if the monitor cannot meet the targets. `jobs_stale` means the reconciler heartbeat is stale; `d1_unavailable` means the D1 probe failed. A fresh `jobs_unknown` response is not proof that scheduled jobs have run. Health/login probes do not replace delivery smoke.

## Incidents

Start with `/healthz`, the latest deploy record, and `pnpm exec wrangler tail --config <config>`. Admin API paths below use `/api/admin/v1`. Close an incident only after the affected behavior recovers, not just after an action succeeds.

| Signal | Check and action | Recovery evidence |
| --- | --- | --- |
| Consecutive failures / slow destination | Inspect attempts and URL/signature/timeout; pause the affected destination, repair the backend/config, test, resume | Fresh successful deliveries |
| `new_dead` | Repair cause, then replay eligible failed/dead deliveries through Failures with a reason; resume only releases paused work | New replay deliveries succeed; original history retained |
| `stuck_pending` / queue backlog | Check consumer logs, queue bindings, reconciler, D1, and destination states; resume paused work only after recovery | Backlog and delivery latency fall |
| Ingress 5xx / D1 overloaded | Correlate request IDs and D1/queue errors; stop competing benchmark/manual load; evaluate recent deploy with rollback table | Valid ingress accepted, health and queue recover |
| `d1_storage` | Review retention and archive workflow health; preview retention changes before saving; repair/start archive workflow | Verified purge progresses and headroom improves |
| `archive_stuck` | Inspect failed/building/verified batches, workflow status, R2/D1 errors; repair dependency and retry through archive run controls | Eligible batch completes verification/purge |
| `backup_stale` | Inspect backup summary, enabled state, workflow and bucket errors; repair and run backup | Fresh verified backup |
| `jobs_stale` / health down | Check cron config, Worker route/version, logs, and D1 probe; redeploy correct config or use rollback decision | Two monitor polls pass and jobs advance |
| Secret exposure | Identify affected credentials and audit changes; rotate using Secrets section | New credential works; old one rejected |
| Platform outage | Check provider status and account notices; avoid unrelated destructive changes; inspect backlog after recovery | Health, deliveries, archive and backup jobs recover |

### Account lockout

If any admin session/token works, reset the target password or correct role/disabled state in Settings → Users. Admin reset revokes that user's sessions and API tokens; reissue automation credentials deliberately.

If all admin access is lost, inspect usernames, roles, disabled state, and whether a password exists without dumping hashes. Last-resort onboarding recovery clears all password hashes, so every user loses login access: secure and verify `SETUP_TOKEN`, record a recovery point, and explicitly choose this account-wide action before running `UPDATE users SET password_hash = NULL`. Claim the admin through `/setup`, restore user passwords, revoke old sessions/tokens, and verify real admin access. See [login](login.md) and [users](users.md).

## Drills

| Acceptance | Status |
| --- | --- |
| Staging rollback, restore A/B, monitoring/canary | Pending — no live evidence recorded |
| Benchmark B6 and recommended limits; production-readiness rollout | Pending in repository release notes |

Record dated results here when performed: UTC times, environment, versions, restore point/backup prefix, exit codes, smoke event/delivery IDs, orphan counts, surprises, and corrective actions; never token values. Rollback must demonstrate failing smoke then successful recovery. Restore must demonstrate data verification plus smoke and record recovery time (RTO) and lost-data window (RPO). Monitoring must demonstrate notification and recovery. Use scratch resources for production backup drills.

Implementation references: [deploy](../scripts/deploy.mjs), [smoke](../scripts/smoke.mjs), [restore](../scripts/restore-backup.mjs), [verify restore](../scripts/verify-restore.mjs). Business behavior: [operations](operations.md), [archives](archives.md), [backup/restore](backup-restore.md), [alerts](alerts.md).
