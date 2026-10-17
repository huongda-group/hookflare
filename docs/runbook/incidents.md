# Incident playbooks

One section per signal (spec §8.3). Every section follows
**Symptom → Check → Act → Close** and names the exact dashboard page,
API path, or wrangler command. Dashboard pages below are the nav items in
`apps/dashboard/src/components/AppShell.tsx`; the admin API is
`/api/admin/v1` (`apps/gateway/src/admin/router.ts`).

> [!NOTE]
> The commands below are derived from the repository code but have
> **not yet been executed against live staging** (the staging drills are
> pending). Every live-staging command is marked **(verify on staging in
> drill)**.

Wrangler runs from the repository root, e.g.
`pnpm exec wrangler … --config apps/gateway/wrangler.staging.jsonc`
(staging) or `--config apps/gateway/wrangler.jsonc` (production).
`d1 execute` below targets the bound database in that config.

## `consecutive_failures`

A destination failed delivery `failure_threshold` times in a row.

- **Symptom:** M5 alert `consecutive_failures` on the Alerts page
  (`/alerts`, detail `/alerts/:id`).
- **Check:** Open the destination (`/endpoints/destinations/:id`, or
  `GET /api/admin/v1/destinations/:id`) and its recent attempts on the
  Failures page (`/failures`, or `GET /api/admin/v1/failures`). Read the
  error: 4xx from the upstream means their endpoint rejects us; timeouts
  / 5xx / DNS mean their endpoint or the network is down.
- **Act:** If the upstream is broken, pause the destination
  (`POST /api/admin/v1/destinations/:id/pause`) so the queue stops
  burning retries, tell the upstream owner, then resume
  (`POST /api/admin/v1/destinations/:id/resume`) — resume resets
  `consecutive_failures` to 0. If our signing or URL is wrong, fix it
  with `PATCH /api/admin/v1/destinations/:id` and send a test
  (`POST /api/admin/v1/destinations/:id/test`).
- **Close:** The alert auto-resolves when deliveries succeed again;
  confirm on the Alerts page that it closed and that the destination
  shows fresh successes.

## `new_dead`

Deliveries exhausted all retries and landed in the DLQ.

- **Symptom:** M5 alert `new_dead` naming the destination and the dead
  delivery IDs.
- **Check:** Failures page (`/failures`) and the event detail
  (`/events/:id`, or `GET /api/admin/v1/events/:id`) for the last error
  before each delivery died. Confirm the destination is still reachable.
- **Act:** Fix the cause (same moves as `consecutive_failures` above),
  then resume the destination
  (`POST /api/admin/v1/destinations/:id/resume`); resume re-queues the
  paused deliveries. Dead deliveries already in the DLQ queue
  (`hookflare-deliveries-dlq`, staging `hookflare-deliveries-dlq-staging`)
  are inspected with `wrangler tail` during the incident, not replayed by
  hand.
- **Close:** The alert carries over until the quiet period passes with no
  fresh dead deliveries; confirm closure on the Alerts page.

## `stuck_pending`

Events sit in `pending` past the stuck threshold — the queue consumer is
not draining.

- **Symptom:** M5 alert `stuck_pending` with the oldest stuck event age.
- **Check:** `GET /api/admin/v1/events` filtered to `pending`, oldest
  first. Check the Worker status in the Cloudflare dashboard
  (Workers & Pages → the gateway Worker) and recent errors with
  `pnpm exec wrangler tail --config <config>` (verify on staging in drill).
- **Act:** If a bad deploy broke the consumer, roll back
  (`pnpm exec wrangler rollback <version-id> --config <config>`; see
  [rollback.md](rollback.md)). If the queue itself is backed up, see
  "Queue backlog growing" below. Paused destinations also hold events in
  `pending` — resume them (`POST /api/admin/v1/destinations/:id/resume`)
  once the cause is fixed.
- **Close:** Confirm `pending` drains to zero on the Events page
  (`/events`) and the alert closes.

## `d1_storage`

The database is approaching the D1 size limit (opens at `d1_warn_pct`,
stays open until 5 points lower — hysteresis).

- **Symptom:** M5 alert `d1_storage` with `size_bytes` and `percent`.
- **Check:** Confirm with
  `pnpm exec wrangler d1 execute <db> --remote --command "SELECT 1"`
  `--config <config>` metadata (`size_after`), and look at the Archives
  page (`/archives`) for `verified` batches never purged.
- **Act:** Purge old verified archive batches (Archives page), lower the
  retention window (`PATCH /api/admin/v1/settings`), and delete dead
  test projects/destinations. This buys time; a growing database needs a
  retention decision, not repeated purges.
- **Close:** The alert closes when usage drops below the hysteresis
  threshold; record the new headroom in the drill/incident note.

## `archive_stuck`

An archive batch failed (and no later batch of the same kind and day
succeeded), sat in `building` over 48 h, or sat `verified` over 48 h
without purge.

- **Symptom:** M5 alert `archive_stuck` with the stuck `batch_ids`.
- **Check:** Archives page (`/archives`, or
  `GET /api/admin/v1/archives`), then the batch detail for the error.
  `failed` means the batch job errored; `building` for 48 h means the
  run died; `verified` for 48 h means purge keeps failing.
- **Act:** Failed days are retried automatically — fix the underlying
  error (usually R2 or D1, see those playbooks) and let the next run
  retry; a batch stuck in `building` is a dead run and is superseded by
  the next run. If purge keeps failing, check the R2 bucket and D1
  health first.
- **Close:** Confirm a later batch of the same kind and day reaches
  `verified`/`purged`/`expired` and the alert closes.

## `backup_stale`

No verified full-DB backup in the last 36 h.

- **Symptom:** M5 alert `backup_stale` with `last_verified_at` (never
  alerts while `backup_enabled` is off, and a fresh deployment gets a
  grace period).
- **Check:** `GET /api/admin/v1/backups/summary` — is the scheduled run
  failing, or is `backup_enabled` off? Check the alert channel for the
  run's error and the R2 `hookflare-backups` bucket for recent parts.
- **Act:** Fix the cause and trigger a manual run
  (`POST /api/admin/v1/backups/run`); confirm it reaches `verified`.
  Details: [backup-restore.md](backup-restore.md).
- **Close:** Confirm `last_verified_at` is fresh and the alert closes.
  If backups were intentionally off, that is a settings decision —
  record it, do not just silence the alert.

## Health check down

- **Symptom:** The external monitor (see [monitoring.md](monitoring.md))
  pages: `GET /healthz` is not `200 {"status":"ok"}` twice in a row.
- **Check:** `curl https://<host>/healthz`. `503 {"reason":"jobs_stale"}`
  means the Worker and D1 are up but the per-minute jobs (reconciler,
  alerts) have not beaten the heartbeat in 5 minutes — the cron triggers
  are missing or failing. `503 {"reason":"d1_unavailable"}`
  means the D1 probe failed. No response means the Worker is down or the
  route/Access bypass is broken.
- **Act:** `jobs_stale`: check the cron triggers are deployed
  (`wrangler deployments list --config <config>`) and the Worker logs
  (`wrangler tail`); a deploy that dropped crons needs a redeploy with
  the correct config. D1 probe failing: see "D1 overloaded". Worker
  down: roll back ([rollback.md](rollback.md)).
- **Close:** Confirm two consecutive monitor polls pass and the page
  resolves.

## Ingress `5xx` spike

- **Symptom:** Providers report failures, or `POST /in/:id` returns
  `500` on valid signatures.
- **Check:** Worker logs (`wrangler tail`) for `http.unhandled_error`
  with `request_id`; correlate the `request_id` the client got. Check
  `/healthz` and the D1 playbook — most ingress 500s are D1 or queue
  errors, not routing bugs. Confirm the Access bypass for `/in/*` is
  intact (a bypass failure looks like non-5xx rejections, not 500s).
- **Act:** If a deploy caused it, roll back ([rollback.md](rollback.md)).
  If D1/queue is the cause, follow that playbook. Pause nothing on the
  Hookflare side unless a single abusive source is the load — rate
  limiting is per source (`INGRESS_LIMITER`).
- **Close:** Confirm providers succeed again and the 5xx rate in logs is
  back to baseline.

## Queue backlog growing

- **Symptom:** `pending` events grow faster than deliveries complete;
  delivery latency climbs.
- **Check:** Events page (`/events`) pending count over time; Destinations
  page stats (`GET /api/admin/v1/destinations/stats`); Worker logs for
  consumer errors. Identify whether one slow destination (its upstream
  timing out) or all destinations are slow.
- **Act:** One slow destination: pause it
  (`POST /api/admin/v1/destinations/:id/pause`) so it stops holding the
  batch, then resume after its upstream recovers. Everything slow: check
  D1 (see "D1 overloaded") — the consumer is usually waiting on the
  database, not on CPU.
- **Close:** Confirm the pending count drains and latency returns to
  baseline.

## D1 overloaded

- **Symptom:** Timeouts and `health.d1_failed` in logs, `/healthz`
  `503`, slow admin API and consumer.
- **Check:** `/healthz` body (D1 probe vs `jobs_stale`); `wrangler tail`
  for D1 error rates; Cloudflare dashboard → D1 → the database → query
  stats. Check whether a backup full-read or a benchmark is running at
  the same time.
- **Act:** Stop any competing load (benchmark, manual backup run). If a
  deploy introduced a hot query, roll back ([rollback.md](rollback.md)).
  D1 has no knob to turn on the Hookflare side — reduce load, then wait
  for recovery. If this recurs, it is a capacity finding for the next
  benchmark round, not a one-off.
- **Close:** Confirm `/healthz` is `200`, tail is clean, and the queue
  drains.

## Leaked source or destination secret

- **Symptom:** A webhook signing secret or destination signing secret is
  reported exposed (or committed) — treat as compromised until rotated.
- **Check:** Identify which source or destination
  (`/endpoints/sources/:id` or `/endpoints/destinations/:id`). Check the
  audit log (Audit page, `/audit`, or `GET /api/admin/v1/audit-logs`)
  for unexpected changes to that row.
- **Act:** Rotate through the dashboard or the API: sources via
  `POST /api/admin/v1/sources/:id/rotate-secret`, destinations via
  `POST /api/admin/v1/destinations/:id/rotate-secret` (grace window for
  the previous value). **Wait 30 s after rotating a source secret**
  — the inbound cache keeps accepting the old value until it expires.
  Give the new secret to the provider / upstream. If `SECRETS_KEY`
  itself leaked, follow [secrets.md](secrets.md) (new key, keep the old
  as `SECRETS_KEY_PREVIOUS` until re-entered, then remove).
- **Close:** Confirm new webhooks verify with the new secret (send a
  test event) and the old value is dead after the cache window.

## Dashboard lockout

- **Symptom:** Nobody can log in: Access rejects everyone, or every
  login lands on a user with no permissions.
- **Check:** Is it Access (login page errors, wrong team domain) or
  Hookflare (login works, API returns `403`)? For 403s, check the Users
  API (`GET /api/admin/v1/users` — needs an operator session, so use a
  service-token session if one still works) for whether any admin row
  remains.
- **Act (Access misconfigured):** Fix the Access application and its
  policies in the Cloudflare Zero Trust dashboard (application covering
  `/` and `/api/admin/*`, bypass for `/in/*` and `/healthz`).
- **Act (no admin left):** Set `BOOTSTRAP_ADMIN_EMAILS` to a controlled
  address and redeploy — bootstrap emails are granted admin on first
  login. Then log in, re-create the real admin users on the Users page
  (or `POST /api/admin/v1/users`), remove the temporary bootstrap
  address, and redeploy. Service-token identities (`svc:<client id>`)
  are never created by bootstrap emails, so automation access is
  unaffected either way.
- **Close:** Confirm a real admin can log in and act, the temporary
  bootstrap address is removed, and the redeploy is recorded.

## Cloudflare platform incident

- **Symptom:** Multiple unrelated things fail at once (Workers, D1,
  Queues, Access), with no Hookflare deploy or settings change behind
  it.
- **Check:** [cloudflarestatus.com](https://www.cloudflarestatus.com/)
  and the Cloudflare dashboard account notices. Confirm our config did
  not change: latest deploy version, Access policies, queue and D1
  bindings untouched in the audit log (`/audit`).
- **Act:** Do nothing destructive — no rollback, no restore, no secret
  rotation. Providers retry with backoff, so redeliver the backlog by
  resuming paused destinations once the platform recovers; do not replay
  the DLQ by hand.
- **Close:** After the all-clear, verify `/healthz` is `200`, the queue
  drains, no `backup_stale`/`archive_stuck` alerts linger from the
  outage window, and the next scheduled backup reaches `verified`.
