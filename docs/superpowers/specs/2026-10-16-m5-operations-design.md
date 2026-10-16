# M5 — Operations: Design Spec

> Milestone M5 of the [roadmap](2026-10-14-hookflare-roadmap.md). M4 shipped the dashboard, so operators can see and act on everything, but only when they are looking at it. M5 makes Hookflare safe to run unattended: a per-destination limiter protects backends from bursts, alerts tell operators when deliveries go wrong, and archive and retention keep D1 bounded. It also closes two items M2 deferred: the §7.2 step 3 limiter, and alerting on dead deliveries.
>
> M5 is one spec delivered as **three PRs, in this order**: **M5a Limiter** (§5), **M5b Alerts** (§6), **M5c Archive & retention** (§7). Each PR has its own migration and leaves `main` releasable. The limiter goes first because it changes the consumer's hot path; the archive goes last because it is the only part that deletes data.

## 1. Goal and exit criteria

**Goal:** Hookflare can run for months without an operator watching the dashboard. No backend receives more than its configured concurrency or rate. Every delivery problem that needs a human reaches Discord, Slack, or Telegram within about a minute. D1 holds only recent data, and everything older can be downloaded from R2.

**Exit criteria (roadmap M5):**
1. Alerts fire for 5 consecutive failures, for new DLQ (`dead`) entries, and for deliveries pending longer than 5 minutes.
2. Archives are verified before anything is deleted, and re-running after a failure is safe.
3. The limiter never consumes attempts.

## 2. Scope

**In scope**
- **M5a:** the `DestinationLimiter` Durable Object; `max_in_flight` and `rate_limit_per_s` on destinations (API, form, audit); the consumer's limiter step.
- **M5b:** `alert_channels` (Discord, Slack, Telegram) with routing by rule and project; incidents in `alerts`; a notification outbox; the alerts job (every minute); settings key `alert_rules`; the Alerts page, the Overview banner, and Settings › Alerts.
- **M5c:** the `ArchiveWorkflow` (Cloudflare Workflows) started by the `0 3 * * *` cron; event archive, audit archive, and archive retention; settings key `storage`; the Archives page and Settings › Storage; "Run now".

**Out of scope (and the milestone that adds it)**
- Searching, previewing, or replaying archived data. The archive is cold storage: list and download only (DEC-12).
- Restoring an archive into D1 (backlog).
- Alert channels other than Discord, Slack, and Telegram; a generic outbound alert webhook; email (backlog).
- Alert acknowledgement, silencing, and on-call escalation (backlog). Incidents open and resolve automatically.
- Retention for `stats_hourly` and `test_deliveries` (backlog; both are small).
- Splitting ingress into its own Worker (M6).

## 3. Decisions taken in this spec

| # | Topic | Decision | Why |
|---|---|---|---|
| M5-1 | Delivery order | Three PRs: Limiter → Alerts → Archive. | The limiter is small and touches the hot path, so it lands first. The archive deletes data and gets the most review, so it lands last. |
| M5-2 | Limiter state | One `DestinationLimiter` DO per destination (`idFromName(destinationId)`), SQLite-backed storage. The consumer passes the limits on every call; the DO never reads D1. | A policy change applies to the next delivery without invalidating anything. The DO stays a pure counter. |
| M5-3 | In-flight slots | A slot expires at `now + leaseMs`, where `leaseMs = timeout + LEASE_GRACE_MS` (the same as the D1 lease). Expired slots are pruned on every `acquire`. | A worker that dies without releasing cannot leak capacity for longer than one lease. |
| M5-4 | Rate | A token bucket with capacity `rate_limit_per_s` (at most one second of burst), refilled continuously, persisted in DO storage. | Smooth rate without a fixed-window burst at each second boundary. Eviction does not reset it. |
| M5-5 | Limiter rejection | **Ack and send a new delayed message.** Fall back to `msg.retry()` only when that send fails. | `msg.retry()` increments `msg.attempts`; a backend that stays busy would reach `max_retries` and the DLQ without a single real attempt. Same pattern as M2-1. |
| M5-6 | Limiter fast path | When both limits are `NULL`, the consumer never calls the DO. | Unlimited destinations (the default) pay no extra latency. |
| M5-7 | Limiter failure | A DO error or timeout (2 s) is an infra error: `msg.retry()` with the infra backoff, no attempt. A failed `release` is only logged. | Fail closed: sending without knowing whether a slot is free can overload the backend the limiter exists to protect. A lost release expires on its own (M5-3). |
| M5-8 | Alert channels | Discord and Slack incoming webhooks, and the Telegram Bot API. Many channels, each routed by `rules` and `project_ids` (`[]` = all). | The team uses Discord today; Slack and Telegram cover most other teams. Routing lets one project page a different channel. |
| M5-9 | Channel secrets | The whole channel config (webhook URL, or Telegram bot token + chat ID) is encrypted with `SECRETS_KEY`. Responses show a fingerprint and, for Telegram, the chat ID. | A Discord or Slack webhook URL is a bearer credential. Same handling as M3 source secrets. |
| M5-10 | Channel URLs | A host allowlist replaces the DoH SSRF check for alerts: `discord.com` / `discordapp.com` under `/api/webhooks/`, `hooks.slack.com` under `/services/`, and the fixed `api.telegram.org` endpoint. HTTPS only, `redirect: "manual"`. | Alerts never need arbitrary hosts. An allowlist is stricter than the SSRF guard and needs no DNS lookup. |
| M5-11 | Incidents | At most one open incident per `(rule, resource_type, resource_id)`, enforced by a partial unique index. Opening is `INSERT … ON CONFLICT DO NOTHING`. | Two overlapping cron runs cannot open duplicates. DEC-6. |
| M5-12 | Consecutive failures | A counter `destinations.consecutive_failures`, updated in the same batch as each recorded attempt: `0` on `delivered`, `+1` on any other outcome. | The job reads one indexed column instead of scanning `delivery_attempts` per destination every minute. Test deliveries live in `test_deliveries` and never touch it. |
| M5-13 | Dead deliveries | `new_dead` is driven by a watermark (`settings` key `alerts.dead_cursor`) over `completed_at` of `dead` deliveries. It resolves after a quiet period with no new dead deliveries. The DLQ consumer is unchanged. | Replay never mutates a dead delivery, so "no dead deliveries left" never becomes true. The rule also covers dead deliveries from the retry budget, not only from the DLQ. |
| M5-14 | Notification delivery | A transactional outbox: each state change writes one `alert_notifications` row per matching channel in the same batch as the incident change. The same job run then sends pending rows; each row gets 3 tries across runs. | A failing channel never blocks or duplicates another, and the history is visible in the UI. |
| M5-15 | Message format | Plain text, at most 1,800 characters: rule, resource name, project, details, and a link `PUBLIC_BASE_URL/alerts/<id>`. | No per-platform Markdown escaping. Fits Discord's 2,000-character limit. |
| M5-16 | Archive executor | Cloudflare **Workflows**: `ArchiveWorkflow`, started by the daily cron with instance ID `archive-YYYY-MM-DD`. Step logic lives in plain functions that take `Deps`. | Workflows persists every step result and retries failed steps, which is exactly "resume after failure". The date-based instance ID dedupes cron runs. A cron handler alone has 30 s of CPU. |
| M5-17 | Archive selection | **Mark, then archive.** Each part first marks its events with `archive_batch_id` / `archive_part`; the file contains exactly the marked events; purge deletes only marked events that are still eligible. Replay clears the mark in its own batch. | Without marks, an event that turns terminal, or gets a replay, between build and purge could be deleted without being archived. With marks, the deleted set is always a subset of the archived set. |
| M5-18 | Archive batches | `archive_batches` keyed by ID, with `day` as a column, replacing `archive_days` keyed by day. | One day is archived more than once: delivered events after 30 days, failed events after 90, and replayed events later still. |
| M5-19 | Part files | Each part is written with a single R2 `put` (gzip built in memory), capped at 5,000 events **and** 32 MiB of raw payload. The put passes `sha256`, so R2 rejects a corrupted upload. | R2 multipart requires equal-size parts, which a gzip stream cannot guarantee. One part per step keeps every step small and idempotent. |
| M5-20 | Purge order | Delete from D1 first, then the `events/…` R2 objects. The R2 keys are part of the purge step's persisted result. | A crash in between leaves at worst an orphaned R2 object, never an event without its payload. A retried step still knows which keys to delete. |
| M5-21 | Disabled archive | `archive_enabled = false` runs the same mark → purge path without writing files (`with_files = 0`). | One code path and the same guards for both modes. |
| M5-22 | Step budget | One instance runs at most 8,000 steps. Unfinished batches continue on the next run. | Stays under the 10,000-step Workflows limit even on the first run over months of backlog. |
| M5-23 | Archive download permission | `GET /archives/:batchId/parts/:n` needs `payload.read` (operator and admin) and writes `archive.downloaded` to the audit log. | Archive files contain payloads; `payload.read` already guards payloads (M3-12). No new permission. |

### 3.1 Deviations from the roadmap and earlier milestones

| Source | Change | Reason |
|---|---|---|
| Roadmap §7.2 step 3 "rejected → `msg.retry({delaySeconds: 5–30})`" | Ack and send a new delayed message; `msg.retry()` only as a fallback | M5-5 |
| Roadmap §6 `archive_days` (PK `day`) | `archive_batches` + `archive_parts` | M5-18 |
| Roadmap §7.4 path `archive/YYYY/MM/DD/part-NNNN.ndjson.gz` | `archive/YYYY/MM/DD/<batch_id>/part-NNNN.ndjson.gz` (and `archive/audit/…/<batch_id>/…`) | M5-18 |
| Roadmap §7.4 "R2 multipart" | One `put` per part | M5-19 |
| Roadmap §7.4 "HEAD every part and match counts" | HEAD (size + sha256) **and** match the count of marked events in D1 | M5-17 |
| Roadmap §6 `alerts` | Adds `project_id`; `details` becomes `details_json`; adds `alert_channels` and `alert_notifications` | M5-8, M5-14 |
| DEC-6 "a generic outbound webhook" | Typed Discord, Slack, and Telegram channels | M5-8, M5-10 |
| DEC-6 "cooldown" | Reminders every `reminder_s` while open, a quiet period for `new_dead`, and hysteresis for `d1_storage` | §6.2 |
| M2 "the DLQ consumer opens an alert" | The `new_dead` rule detects every dead delivery; the DLQ consumer is unchanged | M5-13 |
| Roadmap §8 "download archive: operator+" | Uses the existing `payload.read` | M5-23 |
| §5.1 CHECK 1–1000 on the limit columns | Enforced by the API only | A table-level CHECK makes drizzle-kit rebuild `destinations` |
| §6.1 reclaim by `created_at` | `alert_notifications.claimed_at` | A retried row would otherwise be reclaimable while being sent |
| §4 `jobs/alerts/channels.ts` | `core/alert-channels.ts` | The admin "Send test" route uses it; `admin/` does not import `jobs/` |
| §6.2 `new_dead` window `(cursor, now]` | `(cursor, now − 10 s]`; a missing cursor starts there without alerting | Clock skew; no page storm on first deploy |
| §6.5 channel delete marks notifications `failed` | Deletes the channel's notifications | `alert_notifications.channel_id` is an FK |
| §7.4 one `purge` step | `purge` (D1, returns keys) + `purge-r2` (deletes them) | Only a finished step's result survives a retry (M5-20) |
| §7.6 download | `404` unless `verified`/`purged` with files | A building or failed batch can hold an incomplete part |

## 4. Layout

```text
apps/gateway/src/
  index.ts                     # + export DestinationLimiter, ArchiveWorkflow
  deps.ts                      # + limiter(destinationId), archive (Workflow binding)
  delivery/
    consumer.ts                # + step 7a limiter (§5.3)
    limiter.ts                 # DestinationLimiter DO (§5.2)
  core/
    settings.ts                # + alert_rules, storage (same cache pattern as retry_defaults)
    db/alerts.ts               # incidents, notifications
    db/archive.ts              # eligibility, mark, purge statements
  jobs/
    scheduled.ts               # + alerts on "* * * * *", archive start on "0 3 * * *"
    alerts/
      rules.ts                 # the four rule evaluators
      job.ts                   # evaluate → open/resolve/remind → outbox
      channels.ts              # Discord/Slack/Telegram senders, allowlist
    archive/
      workflow.ts              # ArchiveWorkflow: orchestration only
      plan.ts  part.ts  verify.ts  purge.ts  retention.ts  audit.ts
      ndjson.ts                # line format, gzip, sha256
  admin/routes/
    alerts.ts  alert-channels.ts  archives.ts
    destinations.ts            # + max_in_flight, rate_limit_per_s
    settings.ts                # + alert_rules, storage
    replay.ts                  # (admin/replay.ts) + clear archive mark
apps/dashboard/src/routes/
  alerts.tsx  alerts.$alertId.tsx  archives.tsx
  settings.tsx                 # + Storage and Alerts tabs
packages/shared/src/           # + schemas for limits, channels, alert_rules, storage
```

`wrangler.jsonc` gains a `durable_objects` binding `LIMITER` (class `DestinationLimiter`) with a `new_sqlite_classes` migration, a `workflows` binding `ARCHIVE` (class `ArchiveWorkflow`, name `hookflare-archive`), and the cron `0 3 * * *`. `worker-configuration.d.ts` is regenerated with `pnpm cf-typegen`.

## 5. M5a — Destination limiter

### 5.1 Schema — `0007_limiter.sql` (generated)

`destinations` gains:
- `max_in_flight INTEGER NULL`, CHECK 1–1000.
- `rate_limit_per_s INTEGER NULL`, CHECK 1–1000.

`NULL` means unlimited. These are not part of `retry_defaults`: limits describe one backend, so a global default would be wrong for most of them.

### 5.2 `DestinationLimiter` (RPC)

```ts
acquire(req: { maxInFlight: number | null; ratePerS: number | null; leaseMs: number }):
  Promise<{ ok: true; slotId: string } | { ok: false; reason: "in_flight" | "rate"; retryAfterMs: number }>
release(slotId: string): Promise<void>
```

`acquire`, in one storage transaction:
1. Delete slots with `expires_at ≤ now`.
2. If `maxInFlight` is set and the slot count is `≥ maxInFlight`: reject `in_flight`, with `retryAfterMs` = time until the earliest slot expires, clamped to 5–30 s.
3. If `ratePerS` is set: refill tokens (`min(cap, tokens + elapsed × ratePerS)`). If fewer than 1: reject `rate`, with `retryAfterMs = (1 − tokens) / ratePerS × 1000`. Otherwise take one token.
4. Insert a slot `{ id, expires_at: now + leaseMs }` and return it.

A rate-only destination still gets a slot (so `release` is uniform), but step 2 ignores it. When a limit is lowered below the current slot count, new acquires are rejected until enough slots are released or expire. Releasing an unknown or expired slot is a no-op.

### 5.3 Consumer step 7a

Between the pre-lease checks (§7 steps 3–6) and the lease (step 7):

```text
limits set? ──no──────────────────────────────► lease
    │ yes
acquire ──reject──► ack + queue.send({deliveryId}, {delaySeconds}) ; log delivery.limited
    │ ok           (send fails → msg.retry({delaySeconds}))
lease ──0 rows──► release ; ack
    │
send → record → release (finally)
```

- `delaySeconds = clamp(ceil(retryAfterMs / 1000) + jitter(0–3 s), 1, 30)`. The jitter spreads rejected messages that would otherwise all return together.
- The delivery stays in its current status (`queued` or `retrying`) and is not leased. Nothing in D1 changes, so no attempt is counted (exit criterion 3).
- Any exception from `acquire`, or no response within 2 s, is `infra("limiter", err)`.
- `release` runs in a `finally` after the record step, and also when the lease is not acquired. Its errors are logged as `delivery.limiter_release_failed` and ignored.
- Log `delivery.limited` with `reason`, `delay_s`, and `destination_id`.

`Deps` gains `limiter(destinationId): LimiterStub`, so tests can inject a fake without a DO.

### 5.4 API and dashboard

- The destination create and patch schemas in `@hookflare/shared` accept `max_in_flight` and `rate_limit_per_s` (integer 1–1000 or `null`). The responses return them. Changes are audited like the other policy fields.
- The "Delivery policy" section of the destination form gets two inputs. Empty means unlimited; the placeholder says "Unlimited".

### 5.5 Tests

- **DO:** in-flight rejects at the limit and accepts after `release`; slots expire after `leaseMs` (advance time); the token bucket allows a burst of `ratePerS` and then refills; lowering a limit mid-flight; state survives a new stub for the same ID.
- **Consumer:**
  - A rejection leaves `attempt_count` and status unchanged, acks, and sends one message with a delay in [1, 30].
  - A failing send falls back to `retry`.
  - A DO error is an infra retry.
  - The fast path never calls the limiter.
  - `release` runs after a send, after a lost lease, and when the record step throws.
- **API:** bounds validation; `null` clears a limit; the audit diff.

## 6. M5b — Alerts

### 6.1 Schema — `0008_alerts.sql` (generated)

```text
alert_channels       id (ach_), name, type CHECK (discord|slack|telegram),
                     config_enc, config_fingerprint, chat_id NULL,
                     enabled, rules_json, project_ids_json, created_at, updated_at
alerts               id (alr_), rule, resource_type CHECK (destination|system),
                     resource_id, project_id NULL, status CHECK (open|resolved),
                     opened_at, last_notified_at NULL, resolved_at NULL, details_json
                     UNIQUE (rule, resource_type, resource_id) WHERE status = 'open'
                     INDEX (status, opened_at)
alert_notifications  id (ant_), alert_id → alerts, channel_id → alert_channels,
                     kind CHECK (opened|reminder|resolved),
                     status CHECK (pending|sending|sent|failed),
                     tries, last_error NULL, created_at, sent_at NULL
                     INDEX (status, created_at)
destinations         + consecutive_failures INTEGER NOT NULL DEFAULT 0
                     INDEX (consecutive_failures)
```

`recordLeasedAttempt` adds `consecutive_failures = 0` (outcome `delivered`) or `consecutive_failures + 1` (any other outcome) to its existing fenced batch. A stale worker whose fence fails updates nothing.

### 6.2 Rules

The `settings` key `alert_rules` (zod schema in `@hookflare/shared`, same 30 s cache as `retry_defaults`):

| Field | Default | Bounds |
|---|---|---|
| `failure_threshold` | 5 | 2–100 |
| `stuck_after_s` | 300 | 60–86,400 |
| `dead_quiet_s` | 1,800 | 300–86,400 |
| `d1_warn_pct` | 80 | 50–95 |
| `reminder_s` | 3,600 | 0 (never) or 600–86,400 |

| Rule | Resource | Opens when | Resolves when |
|---|---|---|---|
| `consecutive_failures` | destination | `consecutive_failures ≥ failure_threshold` | the counter drops below the threshold (a delivery succeeded) |
| `new_dead` | destination | a `dead` delivery has `completed_at > alerts.dead_cursor` | no new dead delivery for `dead_quiet_s` |
| `stuck_pending` | destination | a delivery in `pending` or `queued` was created more than `stuck_after_s` ago | no such delivery remains |
| `d1_storage` | system / `d1` | DB size ≥ `d1_warn_pct` of 10 GB | DB size < `d1_warn_pct − 5` % (hysteresis) |

- Paused destinations are excluded from `stuck_pending`; their deliveries are `paused`, not `pending`.
- `stuck_pending` also fires when the limiter holds back a growing backlog. That is intended: a backlog older than the threshold needs a human either way.
- `new_dead`: each run reads dead deliveries with `completed_at` in `(cursor, now]`, groups them by destination, opens or updates an incident per destination (`details_json` counts them and keeps the 5 newest delivery IDs), and advances the cursor to `now` in the same batch. A new dead delivery on an already open incident updates `details_json` and its last-seen time, but sends no notification (reminders cover it).
- `d1_storage` reads the size from `meta.size_after` of a trivial query.
- `consecutive_failures` resolves on the first success, so a backend that alternates between 5 failures and 1 success opens and resolves repeatedly. This is accepted: each cycle is a real outage.

### 6.3 Job

Runs on the `* * * * *` cron, next to the reconciler, each in its own `try/catch`. Each run:

1. **Evaluate** the four rules into a set of active `(rule, resource)` keys with details.
2. **Open:** for each active key with no open incident, one batch: `INSERT … ON CONFLICT DO NOTHING RETURNING id`; when a row is returned, insert `opened` notifications for every matching channel.
3. **Resolve:** for each open incident whose key is no longer active, one batch: `UPDATE … SET status='resolved' WHERE id = ? AND status='open'`, plus `resolved` notifications.
4. **Remind:** for open incidents with `reminder_s > 0` and `last_notified_at ≤ now − reminder_s`, insert `reminder` notifications and set `last_notified_at`.
5. **Send:** claim up to 50 rows (`UPDATE … SET status='sending' WHERE status='pending' OR (status='sending' AND created_at < now − 60 s) … RETURNING`), send each with a 5 s timeout, and mark it `sent`, back to `pending` (`tries < 3`), or `failed`. A row stuck in `sending` because a run died is claimed again after 60 s.

**Routing:** a channel matches when it is enabled, its `rules_json` is empty or contains the rule, and its `project_ids_json` is empty or contains the incident's `project_id`. Incidents with no project (`d1_storage`) go only to channels whose `project_ids_json` is empty. Channels are matched when the notification is written; a later edit to a channel does not re-route old notifications.

### 6.4 Channels

| Type | Config (encrypted) | Request |
|---|---|---|
| `discord` | `{ url }` | `POST url`, `{ "content": text }` |
| `slack` | `{ url }` | `POST url`, `{ "text": text }` |
| `telegram` | `{ bot_token, chat_id }` | `POST https://api.telegram.org/bot<token>/sendMessage`, `{ chat_id, text, disable_web_page_preview: true }` |

- URL validation (M5-10): Discord `https://discord.com/api/webhooks/…` or `https://discordapp.com/api/webhooks/…`; Slack `https://hooks.slack.com/services/…`. Telegram tokens must match `^\d+:[A-Za-z0-9_-]{30,}$`.
- Any 2xx is success. 429 and 5xx count as a failed try. Response bodies are never stored, only the status and a 200-character error message.
- The fingerprint is the first 8 hex characters of the SHA-256 of the config JSON. `chat_id` is stored in its own plaintext column for display.

### 6.5 Admin API

| Route | Permission | Notes |
|---|---|---|
| `GET /alerts` | `events.read` | Filters `status`, `rule`, `project_id`; cursor pagination, newest first |
| `GET /alerts/:id` | `events.read` | Incident plus its notifications |
| `GET /alert-channels` | `settings.manage` | No secrets; fingerprint and `chat_id` only |
| `POST /alert-channels` | `settings.manage` | Audited; the config is redacted in the audit diff |
| `PATCH /alert-channels/:id` | `settings.manage` | Name, `enabled`, `rules`, `project_ids`, and optionally a new config. Audited. |
| `DELETE /alert-channels/:id` | `settings.manage` | Audited. Sets pending notifications for the channel to `failed` (`channel_deleted`) in the same batch. |
| `POST /alert-channels/:id/test` | `settings.manage` | Sends a test message synchronously and returns the result. Writes no incident or notification. Audited. |
| `GET` / `PATCH /settings` | as M4 | Adds `alert_rules`, with its own `expected_updated_at` |

`GET /overview` gains `open_alerts: { count, by_rule }`.

### 6.6 Dashboard

- **Alerts page:** open incidents first, then history, filterable by status, rule, and project. Each row shows the rule, resource, project, opened time, and duration. The detail view shows `details_json` (with links to the dead deliveries for `new_dead`) and the notification log per channel.
- **Overview banner:** shown when `open_alerts.count > 0`, linking to the Alerts page filtered to open incidents.
- **Settings › Alerts:** the `alert_rules` form, and the channel list with create, edit, enable/disable, delete, and "Send test". The config inputs are write-only: editing a channel shows the fingerprint and asks for a new URL or token only to replace it.

### 6.7 Tests

- Each rule: opens, stays open without duplicates, resolves, reminds after `reminder_s`, and does not remind when `reminder_s = 0`.
- Two job runs in parallel open one incident.
- `consecutive_failures`: incremented and reset in the fenced batch; a lost lease changes nothing.
- `new_dead`: the cursor advances; dead deliveries from the budget and from the DLQ are both detected; the quiet period resolves.
- `d1_storage` hysteresis.
- Routing: empty lists match all; system incidents skip project-scoped channels.
- Outbox: a failing channel retries up to 3 times without resending to others; a stuck `sending` row is reclaimed.
- Channel payloads for all three types; allowlist rejections; the Telegram token format.
- Admin API: secrets never appear in responses or audit diffs; RBAC matrix and route coverage include every new route.
- Dashboard: banner visibility; write-only config fields; "Send test" result.

## 7. M5c — Archive and retention

### 7.1 Schema — `0009_archive.sql` (generated)

```text
archive_batches  id (arb_), kind CHECK (events|audit), day (YYYY-MM-DD, UTC),
                 status CHECK (building|verified|purged|failed|expired),
                 with_files, part_count, item_count, bytes,
                 workflow_instance_id, error NULL,
                 created_at, verified_at NULL, purged_at NULL
                 INDEX (status), INDEX (day)
archive_parts    batch_id → archive_batches, part_no, r2_key NULL,
                 item_count, bytes, sha256 NULL, first_id, last_id
                 PRIMARY KEY (batch_id, part_no)
webhook_events   + archive_batch_id NULL, archive_part NULL
                 INDEX (archive_batch_id, archive_part)
```

### 7.2 Settings — key `storage`

| Field | Default | Bounds |
|---|---|---|
| `archive_enabled` | `true` | |
| `hot_retention_days` | 30 | 1–3,650 |
| `failed_retention_days` | 90 | ≥ `hot_retention_days`, ≤ 3,650 |
| `archive_retention_days` | `null` (forever) | `null` or 30–36,500 |
| `audit_retention_days` | 365 | 30–36,500 |

### 7.3 Eligibility

An event is eligible when all of the following hold (`now` is the time of the check):

```text
received_at < now − hot_retention_days
AND NOT EXISTS (delivery of the event in a non-terminal status)
AND (NOT EXISTS (delivery in failed_final or dead)
     OR received_at < now − failed_retention_days)
```

An event with no deliveries counts as delivered. An event with any non-terminal delivery never leaves D1 (roadmap invariant).

### 7.4 Workflow

The cron `0 3 * * *` calls `ARCHIVE.create({ id: "archive-<run date>" })`; a duplicate ID error is logged and ignored. `POST /archives/run` uses `archive-manual-<ulid>`. Two instances running at once are safe: marking only takes unmarked events, and each instance only purges its own batches.

Every step is retried up to 5 times with exponential backoff and a 10-minute timeout.

| Step | Work | Why a retry is safe |
|---|---|---|
| `plan` | Load `storage`. Resume this instance's own and any abandoned batches in `building` or `verified` (abandoned = owning instance is no longer running). Then list the UTC days that have unmarked eligible events, oldest first, and create one `events` batch per day; the same for audit days older than `audit_retention_days`. | Existing batches are reused; a day with no unmarked eligible events gets no new batch. |
| `part:<batch>:<n>` | If events are already marked `(batch, n)`, use them. Otherwise mark up to 5,000 unmarked eligible events of the day, ordered by ID, stopping before the running `SUM(size_bytes)` passes 32 MiB (at least one event). When `with_files`: load the events, their payloads (from R2 when `r2_key` is set) as base64, their deliveries, and their attempts; write NDJSON, gzip it, and `put` it with `sha256`. Upsert the `archive_parts` row. Repeat until no event is marked. | The mark is reused, the R2 key is deterministic, and the put overwrites. |
| `verify:<batch>` | For each part: `head()` matches `bytes` and `sha256`, and the number of events still marked `(batch, n)` is at most `item_count` (replay only ever removes marks, and marks are only assigned when the part is built). Then write `manifest.json` (batch ID, day, kind, per-part count, sha256, and ID range) and set `verified`. Any mismatch sets `failed` with `error`; a failed batch is never purged and needs an operator. | Reads, then overwrites the manifest. |
| `purge:<batch>:<n>:<k>` | Requires `verified` (or `with_files = 0`). Select up to 500 events marked `(batch, n)` that are still eligible, and their `r2_key`s. One D1 batch deletes their attempts, deliveries, and events, each statement repeating the mark and eligibility conditions. Then `PAYLOADS.delete(keys)`. Return the keys. After the last chunk of the last part, set `purged`. | The keys are in the persisted step result, so a retry after the D1 delete still deletes the R2 objects. A retried D1 delete matches no rows. |
| `retention` | When `archive_retention_days` is set: for batches with `day` older than it, delete every object under the batch prefix and set `expired`. | A re-run finds nothing to delete. |

- **Replay** (`admin/replay.ts`) adds `UPDATE webhook_events SET archive_batch_id = NULL, archive_part = NULL WHERE id IN (…)` to its existing batch. The unmarked event is skipped by purge and is archived again by a later run. Its first copy stays in the earlier file; the manifest documents that archives can contain an event more than once, and that the copy from the newest batch is the complete one.
- **Audit batches** need no marks, because audit rows never change. A part selects rows with `at` inside the day and `id > previous part's last_id`; purge deletes rows with `at` inside the day and `id ≤ last_id` of a verified part.
- **Step budget** (M5-22): `plan` stops creating batches once the estimated step count reaches 8,000. The remaining days are planned by the next run.
- **Monitoring:** M5c adds a fifth alert rule, `archive_stuck` (resource `system / archive`). It opens when a batch is `failed` or has been `building` for more than 48 hours, and resolves when no such batch remains.
- **Status on failure:** if an instance errors, its batches keep their status. The next run's `plan` resumes them, which is how a re-run after a failure is safe (exit criterion 2).

### 7.5 Line format

One JSON object per line, UTF-8, gzip:

```json
{"v":1,"event":{…all webhook_events columns except body_inline and the archive marks…},
 "payload_b64":"…","deliveries":[{…,"attempts":[{…}]}]}
```

Audit lines are `{"v":1,"audit":{…all audit_logs columns…}}`.

### 7.6 Admin API

| Route | Permission | Notes |
|---|---|---|
| `GET /archives` | `events.read` | Batches, filterable by `kind`, `status`, and a `day` range; cursor pagination, newest first; includes parts |
| `GET /archives/:batchId/parts/:n` | `payload.read` | Streams the R2 object as `application/gzip` with a download filename. Audited (`archive.downloaded`). `404` when expired or written without files. |
| `POST /archives/run` | `settings.manage` | Starts an instance and returns its ID. Audited. |
| `GET /archives/preview` | `settings.manage` | Takes candidate `hot_retention_days` and `failed_retention_days`; returns how many events would become eligible. Read-only. |
| `GET` / `PATCH /settings` | as M4 | Adds `storage`, with its own `expected_updated_at` |

`GET /settings` also returns `archive_last_run`: the latest instance ID, its status from the Workflows API, and its start time.

### 7.7 Dashboard

- **Archives page:** batches grouped by day, showing kind, status, parts, items, and size. Expanding a batch lists its parts with a download button (shown only with `payload.read`). `failed` batches show their `error`.
- **Settings › Storage:** the `storage` form, the last run, and "Run now". Lowering `hot_retention_days` or `failed_retention_days` shows a confirmation with the number of extra events that become eligible (`GET /archives/preview?…`, `settings.manage`).

### 7.8 Tests

- **Eligibility:** every combination of terminal and non-terminal statuses with ages around both cut-offs; an event with no deliveries.
- **Marking:** an event that turns terminal after its part was built is not deleted; a replay after build unmarks the event and the purge skips it; two instances never mark the same event.
- **Verify:** a size, hash, or count mismatch sets `failed` and nothing is purged.
- **Idempotency:** re-running `part`, `verify`, and `purge` after a simulated crash at each point gives the same D1 and R2 state.
- **File content:** gunzip and parse every line; payloads from inline storage and from R2 round-trip byte for byte.
- **Purge:** R2 payload objects are deleted only after the D1 rows; a retry after the D1 delete still deletes them.
- **Retention:** archive expiry; audit cut-off; `archive_enabled = false` deletes without files.
- **Step budget:** a large backlog is split across runs.
- **Workflow:** one end-to-end run of `ArchiveWorkflow` through the `cloudflare:test` Workflows introspection API.
- **API and dashboard:** download permission and audit; `404` for expired batches; the retention confirmation.

## 8. RBAC summary

No new permissions. New routes use `events.read` (alerts, archives list), `payload.read` (archive download), and `settings.manage` (channels, settings, "Run now"). The M3 route-coverage test must include every new route.

## 9. Risks

| Risk | Mitigation |
|---|---|
| The limiter DO becomes a hot spot for a high-volume destination | One RPC per delivery, only when limits are set; the DO does constant work per call. |
| Alert noise from flapping backends | Reminders instead of repeated "opened" messages; hysteresis and quiet periods where a rule allows it. |
| A large archive day exceeds memory | Parts capped at 5,000 events and 32 MiB raw, built one per step. |
| Deleting data that was not archived | Mark-then-archive (M5-17), verification before purge, eligibility re-checked inside every delete. |
| Workflows instance failures go unnoticed | A `failed` batch, or one in `building` for more than 48 hours, opens an `archive_stuck` incident (§7.4). |
