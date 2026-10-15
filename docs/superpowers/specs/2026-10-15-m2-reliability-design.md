# M2 — Reliability: Design Spec

> Milestone M2 of the [roadmap](2026-10-14-hookflare-roadmap.md). M1 delivers each webhook once. M2 makes delivery reliable: retries with backoff, a lease, a retry budget in D1, `dead` + a DLQ consumer, deduplication by provider event ID, R2 for large payloads, a reconciler, Pause/Resume, per-destination retry policy, and a fault-injection test suite.

## 1. Goal and exit criteria

**Goal:** once ingress returns `202`, the webhook reaches the backend at least once as long as the backend recovers within the retry window, and no partial failure (D1, R2, Queue, Worker crash) silently loses a delivery.

**Exit criteria (roadmap, `DESIGN.md` §11):**
1. Never return `202` before the D1/R2/Queue writes complete.
2. A backend that recovers after 48h still receives its webhooks.
3. Duplicates do not create new logical events when a provider event ID is available.
4. The reconciler recovers from partial failures.
5. Tests exist for D1/Queue failure, timeout, retry, duplicates, and SSRF.

## 2. Scope

**In scope**
- Full Retry Policy (`DESIGN.md` §5), exponential backoff with jitter, `Retry-After` for 429.
- Lease with `lease_until`, used as a fencing token when recording results.
- Retry budget in D1 (`attempt_count` vs the destination's `max_attempts`) and the `dead` status.
- Native DLQ `hookflare-deliveries-dlq` + DLQ consumer.
- Deduplication by provider event ID, including a migration that collapses duplicates stored by M1.
- R2 for payloads > 64 KB; `max_body_bytes` up to 10 MB.
- Reconcile job (cron, every minute).
- Pause/Resume endpoints.
- Per-destination policy: `timeout_ms` (exists), `max_attempts`, `backoff_base_s`, `backoff_max_s`.
- Fault-injection helpers and the tests in §10.

**Out of scope (and the milestone that adds it)**
- `max_in_flight`, `rate_limit_per_s`, `DestinationLimiter` (M5). Their columns are added in M5.
- Alerts on `dead` deliveries (M5). M2 only logs.
- Replay, RBAC, `audit_logs` (M3). Pause/Resume use the M1 bootstrap-admin auth and interim audit logs.
- Editing global retry defaults from the UI (M4, Settings › Retry defaults). M2 defaults are code constants.
- A sweeper for orphan R2 objects (§6.2, accepted risk).

## 3. Decisions taken in this spec

| # | Topic | Decision | Why |
|---|---|---|---|
| M2-1 | Retry scheduling | After recording a retryable attempt, the consumer **acks the message and sends a new one** with `delaySeconds`. `msg.retry()` is used only for infra errors, as a fallback when that send fails, and to re-delay a duplicate message that arrives before `next_attempt_at` (§7 step 2). | One message serves one attempt, so `msg.attempts` counts only consecutive infra failures. The native DLQ then catches only poison messages, and M5 limiter rejections can never push a delivery into the DLQ while its D1 budget remains. |
| M2-2 | Lease placement | All checks (destination status, payload load, SSRF, signing) run **before** the lease, as in M1. The lease covers only send + record. | Errors before the lease need no lease release, so an infra error never strands a delivery in `in_flight`. |
| M2-3 | Large payloads | Add `webhook_events.r2_key`. `body_inline` stays `NOT NULL` and holds an empty blob when the payload is in R2. Code enforces "exactly one location holds the payload". | Making a column nullable or adding a `CHECK` requires a SQLite table rebuild of the largest table, which `deliveries` references by FK; D1 migrations cannot turn `foreign_keys` off the way drizzle-kit's rebuild expects. |
| M2-4 | Body size ceiling | `max_body_bytes` default 1 MB, allowed 1 B–10 MB. | Covers providers with large payloads while the buffered body stays far below the 128 MB isolate limit. Streaming verification is not needed. |
| M2-5 | Backoff ceiling | `backoff_max_s` ≤ 43200. | Cloudflare Queues accept `delaySeconds` up to 12h. |
| M2-6 | Infra errors | D1, R2, and DNS resolver errors use `msg.retry` with an exponential delay (60s → 1h) and never count as attempts. After 20 consecutive infra failures the message goes to the DLQ and the delivery becomes `dead`. | Keeps the invariant "infra errors never count as attempts" while still bounding a permanently broken delivery (~15h of consecutive failures). |
| M2-7 | Duplicate semantics | A duplicate always returns `200 {duplicate: true, event_id}` and never creates an event or delivery, whatever the first event's outcome. | `DESIGN.md` §11. Re-sending a failed event is replay (M3). |
| M2-8 | M1 duplicates | Migration `0003` keeps the earliest event of each `(source_id, provider_event_id)` group and sets `provider_event_id = NULL` on the others. No rows are deleted. | Preserves every delivery and attempt and avoids FK cascades. |
| M2-9 | Pause/Resume API | Dedicated `POST /destinations/:id/pause` and `/resume`. `PATCH status` accepts `active \| disabled` from any state; `paused` is reachable only through `/pause`. | Resume has side effects (re-enqueue) that do not belong in a generic `PATCH`. |
| M2-10 | Global defaults | `core/policy.ts` constants: timeout 10000 ms, 20 attempts, base 30s, max 21600s. | Settings UI is M4; YAGNI until then. |

### 3.1 Deviations from the roadmap and M1

| Source | Change | Reason |
|---|---|---|
| Roadmap §7.2 step 7 `retry({delaySeconds})` | Ack + new delayed message | M2-1 |
| Roadmap §6/§7.2 lease first | Checks first, lease last | M2-2 |
| M1 §5 "M2 makes `body_inline` nullable" | Stays `NOT NULL`; empty blob when in R2 | M2-3 |
| Roadmap §7.2 step 3 limiter | Not in M2 | M5 scope |
| Roadmap §7.2 DLQ consumer "opens an alert" | Logs only | Alerts are M5 |
| Roadmap §7.3 reconcile | Adds rules (e)/(e′) for `paused` deliveries (§8.1) | Resume moves only the first batch; the rest must not stay `paused` forever |
| Roadmap §6 backoff | Final delay clamped to `[1, 43200]` s | M2-5 |

## 4. Layout

New and changed files under `apps/gateway/`:

```text
migrations/
├── 0003_collapse_duplicate_event_ids.sql   # custom (drizzle-kit generate --custom)
└── 0004_reliability.sql                    # generated
src/
├── index.ts                  # { fetch, queue (main + DLQ by batch.queue), scheduled }
├── deps.ts                   # + payloads: R2Bucket
├── core/
│   ├── policy.ts             # defaults + resolvePolicy(destination)
│   ├── payloads.ts           # R2 key format, put/get/delete helpers
│   └── db/                   # dedup lookup, lease, record, reconcile queries
├── ingress/route.ts          # dedup, R2, paused deliveries
├── delivery/
│   ├── consumer.ts           # §7
│   ├── classify.ts           # retryable outcomes
│   ├── backoff.ts            # backoff, jitter, Retry-After, infra delay
│   └── dlq.ts                # §8.2
├── jobs/
│   ├── scheduled.ts          # cron dispatcher
│   └── reconcile.ts          # §8.1
└── admin/routes/destinations.ts            # policy fields, pause, resume
test/helpers/faults.ts        # §10.1
```

`ingress/` still must not import from `admin/`; `jobs/` and `delivery/` may import from `core/` only.

### 4.1 Bindings — `wrangler.jsonc`

- `r2_buckets`: `PAYLOADS` → `hookflare-payloads`.
- Queue consumer `hookflare-deliveries`: `max_batch_size: 10`, `max_retries: 20`, `dead_letter_queue: "hookflare-deliveries-dlq"`.
- Queue consumer `hookflare-deliveries-dlq`: `max_batch_size: 10`, `max_retries: 100`, no DLQ.
- `triggers.crons`: `["* * * * *"]`.

`Deps` gains `payloads: R2Bucket`. Handlers never use `env.PAYLOADS` directly.

## 5. Schema

### 5.1 `0003_collapse_duplicate_event_ids.sql` (custom)

Created with `drizzle-kit generate --custom --name collapse_duplicate_event_ids` so it is part of the journal and the drift check still passes. Its only statement:

```sql
UPDATE webhook_events SET provider_event_id = NULL
WHERE provider_event_id IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id) FROM webhook_events
    WHERE provider_event_id IS NOT NULL
    GROUP BY source_id, provider_event_id
  );
```

IDs are ULIDs, so `MIN(id)` is the earliest event of each group.

### 5.2 `0004_reliability.sql` (generated)

| Table | Change |
|---|---|
| `destinations` | + `max_attempts INTEGER NULL`, `backoff_base_s INTEGER NULL`, `backoff_max_s INTEGER NULL` (NULL → default, §3 M2-10) |
| `webhook_events` | + `r2_key TEXT NULL`. Drop `webhook_events_source_provider_idx`; create `webhook_events_source_provider_uq` = `UNIQUE(source_id, provider_event_id) WHERE provider_event_id IS NOT NULL` |
| `deliveries` | + `next_attempt_at INTEGER NULL`, `lease_until INTEGER NULL`. New indexes `deliveries(status, next_attempt_at)`, `deliveries(status, enqueued_at)` |

The plan verifies that drizzle-kit emits the partial `WHERE` and that `0004` contains no table rebuild. `CHECK` constraints are unchanged: every status and `error_kind` M2 writes already exists.

### 5.3 Column semantics

- `next_attempt_at`: set only while `status = 'retrying'`; NULL otherwise.
- `lease_until`: set only while `status = 'in_flight'`; NULL otherwise. Its value is the lease's fencing token (§7.2).
- `r2_key`: `events/YYYY/MM/DD/<evt_id>` (UTC date of `received_at`) when `size_bytes > 65536`; then `body_inline` is a zero-length blob. NULL for inline payloads.

## 6. Ingress — `POST /in/:sourceId`

`SourceBundle` gains `destinationStatus` (cached with the rest, 30s). Steps 1, 2, 4 are unchanged from M1.

| Step | Behavior | Response on failure |
|---|---|---|
| 3. Body cap | Cap = `max_body_bytes ?? 1_048_576` (the M1 `min(…, 65536)` is removed) | `413` |
| 5. Event ID + dedup | Extract `provider_event_id` (M1 §6.2). If non-NULL, look up `(source_id, provider_event_id)`; found → stop | found: `200 {"duplicate":true,"event_id":"evt_…"}`. D1 error: `503` |
| 6. Prepare | sha256, `storableHeaders` (M1) | — |
| 6b. R2 | If `size_bytes > 65536`: `payloads.put(key, body, { sha256, httpMetadata: { contentType } })` | `503` |
| 7. D1 batch | `insert webhook_events … ON CONFLICT DO NOTHING` + `insert deliveries` with status `paused` if `destinationStatus = 'paused'`, else `pending` | §6.1 |
| 8. Enqueue | Skipped for `paused`. `queue.send({ deliveryId })` | `503` (delivery stays `pending`; reconcile (a)) |
| 9. Mark queued | Best effort, as M1 | — |
| 10. Accept | `202 {"event_id":"evt_…"}` | — |

### 6.1 Concurrent duplicates

When a concurrent request has already inserted the same `(source_id, provider_event_id)`, the event insert does nothing, the delivery insert fails its FK, and the batch rolls back. Ingress then repeats the step 5 lookup: found → `200 duplicate`; not found → `503`. Both cases delete the R2 object from step 6b (§6.2).

### 6.2 Orphan R2 objects

When step 7 fails after a successful step 6b, ingress calls `payloads.delete(key)` best effort (`ingress.r2_cleanup_failed` on error). An object left behind is harmless because no row references it. **Accepted risk:** no sweeper removes it in M2; the M5 archive job does not scan `events/` for orphans.

Log lines added: `ingress.duplicate`, `ingress.r2_put_failed`, `ingress.r2_cleanup_failed`. Responses: `202` accepted, `200` duplicate; `400/401/404/413/429/503` as in M1.

## 7. Delivery consumer — `delivery/consumer.ts`

Messages in a batch are processed concurrently. `index.ts` routes a batch to the DLQ consumer (§8.2) when `batch.queue` is `hookflare-deliveries-dlq`.

**Claimable** means `status IN ('pending','queued','retrying') OR (status = 'in_flight' AND lease_until < :now)`.

| Step | Behavior | Message outcome |
|---|---|---|
| 1. Load | Delivery + event + destination. Not found → log `delivery.not_found` | not found: `ack`. D1 error: infra retry |
| 2. Claimable? | Not claimable → log `delivery.skipped`. `retrying` with `next_attempt_at > now` (a duplicate message) → log `delivery.not_due`, no attempt | skipped: `ack`. Not due: `retry` with the remaining delay |
| 3. Destination | `paused` → conditional update to `paused` (`lease_until`/`next_attempt_at` NULL). `disabled` → `failed_final (destination_disabled)`. No attempt | `ack` |
| 4. Payload | `r2_key` NULL → `body_inline`; else `payloads.get(r2_key)`. Object missing → `failed_final (payload_missing)`, no attempt | `ack`. R2 error: infra retry |
| 5. SSRF | `checkUrl` (M1 §8). Blocked → `failed_final (ssrf_blocked: <reason>)`, no attempt | blocked: `ack`. `DnsError`: **infra retry** |
| 6. Sign | M1 §7.1. Failure → `failed_final (signing_failed)`, no attempt | `ack` |
| 7. Lease | `UPDATE deliveries SET status='in_flight', lease_until=:L, next_attempt_at=NULL WHERE id=:id AND <claimable>` with `L = now + timeout_ms + 30_000`. 0 rows → skip | 0 rows: `ack`. D1 error: infra retry |
| 8. Send | M1 §7 step 7, with the resolved `timeout_ms`. `webhook-id` = delivery ID for every attempt | — |
| 9. Record | `db.batch([insert delivery_attempts(attempt_no = attempt_count + 1), update deliveries … WHERE id=:id AND status='in_flight' AND lease_until=:L])`. Update sets `attempt_count + 1`, the §7.1 status, `last_http_status`, `last_error`, `lease_until = NULL`, and for `retrying` also `next_attempt_at` and `enqueued_at = now`; for terminal statuses `completed_at`. 0 rows on the update → the attempt row is not inserted either (§7.2), and the result is logged as `delivery.lease_lost` | D1 error: infra retry |
| 10. Reschedule | `retrying` only: `queue.send({ deliveryId }, { delaySeconds })`. Failure → `msg.retry({ delaySeconds })` and log `delivery.reschedule_failed` | `ack` / `retry` |

Steps 3–6 use conditional updates (`WHERE <claimable>`) so they never overwrite a delivery another consumer already handled. All "no attempt" outcomes leave `attempt_count` unchanged.

### 7.1 Classification and budget — `delivery/classify.ts`

`n = attempt_count + 1` (this attempt's number); `max = resolvePolicy(destination).maxAttempts`.

| Result | `n < max` | `n ≥ max` | `error_kind` |
|---|---|---|---|
| 2xx | `delivered` | `delivered` | NULL |
| 408, 429, 5xx | `retrying` | `dead` | `http_4xx` / `http_5xx` |
| timeout | `retrying` | `dead` | `timeout` |
| other fetch exception | `retrying` | `dead` | `network` |
| 3xx (not followed) | `failed_final` | `failed_final` | `http_3xx` |
| other 4xx | `failed_final` | `failed_final` | `http_4xx` |

The classifier stays a pure function: `(response | error, n, policy, now, random) → Outcome`, where `Outcome` carries `delaySeconds` for `retrying`.

### 7.2 Lease as fencing token

The record update matches `lease_until = :L`. If a reconciler (§8.1 rule b), another consumer, or the DLQ consumer (§8.2) took over after this lease expired, the update affects 0 rows. Because a D1 batch is atomic, the record function runs the update first and makes the attempt insert conditional on it (`INSERT … SELECT … WHERE changes() = 1` or an equivalent the plan verifies), so a stale worker writes neither row. The request was still sent, so the backend may see it twice with the same `webhook-id`: **at-least-once by design**.

### 7.3 Backoff — `delivery/backoff.ts`

- **Retry delay:** `min(base · 2^(n−1), max) × U(0.8, 1.2)`, rounded, clamped to `[1, 43200]` s. `base`/`max` come from `resolvePolicy`.
- **`Retry-After` (429 only):** delta-seconds or HTTP-date relative to `now`. Valid → `clamp(value, 1, backoff_max_s)`, no jitter. Invalid or absent → normal backoff.
- **Infra delay:** `min(60 · 2^(msg.attempts − 1), 3600)` s. 20 consecutive infra failures span about 15h before the DLQ.
- `next_attempt_at = now + delaySeconds · 1000`.

With the defaults (30s, 6h, 20 attempts) the retry window is about 62h (19 delays: 30s doubling to the 6h cap), above the 48h requirement. The minimum infra delay (60s) is never shorter than a lease (`timeout_ms` ≤ 30s + 30s), so a message retried after a failed record finds the lease expired and can re-acquire it.

### 7.4 Policy — `core/policy.ts`

```ts
const DEFAULT_POLICY = { timeoutMs: 10_000, maxAttempts: 20, backoffBaseS: 30, backoffMaxS: 21_600 };
function resolvePolicy(d: DestinationRow): Policy; // NULL column → default
```

`DEFAULT_TIMEOUT_MS` moves from `consumer.ts` to this module.

## 8. Jobs, DLQ, Pause/Resume

### 8.1 Reconcile — `jobs/reconcile.ts`

`scheduled` → `jobs/scheduled.ts` dispatches on `controller.cron`; `* * * * *` runs reconcile. One run handles at most **500 rows in total**, taking rules in this order and passing the remaining budget to each `LIMIT`.

| Rule | Selects | Action |
|---|---|---|
| (a) | `pending`, `enqueued_at IS NULL`, `created_at < now − 60s` | enqueue; then `status='queued', enqueued_at=now` |
| (b) | `in_flight`, `lease_until < now − 5 min` | enqueue; then `status='retrying', next_attempt_at=now, lease_until=NULL, enqueued_at=now` (no attempt counted) |
| (c) | `retrying`, `next_attempt_at < now − 15 min`, `enqueued_at IS NULL OR enqueued_at < now − 15 min` | enqueue; then `enqueued_at=now` |
| (d) | `queued`, `enqueued_at < now − 30 min` | enqueue; then `enqueued_at=now` |
| (e) | `paused` whose destination is `active` | `status='pending', enqueued_at=NULL` (rule (a) enqueues them on a later run) |
| (e′) | `paused` whose destination is `disabled` | `failed_final`, `last_error='destination_disabled'`, `completed_at=now` |

- Enqueue = `queue.sendBatch` in chunks of 100, **then** a conditional update that also re-checks the selected status (and `lease_until` for rule b). Send succeeded but update failed → the next run re-sends; the duplicate message is harmless (lease). Send failed → no update; the next run retries.
- The reconciler only recovers lost messages; it never moves a `next_attempt_at` earlier.
- One log line per run: `reconcile.run` with per-rule counts and `send_failed` chunks.
- A D1 or Queue error stops the run (logged as `reconcile.failed`); the next minute starts over. The job is idempotent.

### 8.2 DLQ consumer — `delivery/dlq.ts`

For each message: `UPDATE deliveries SET status='dead', last_error='dlq: infra retries exhausted', lease_until=NULL, next_attempt_at=NULL, completed_at=:now WHERE id=:id AND <claimable> AND NOT (status='retrying' AND next_attempt_at > :now)`, log `delivery.dead`, `ack`. `paused`, terminal, and live-lease `in_flight` deliveries are left alone, so a worker mid-request still records its result. A `retrying` delivery whose backoff is not yet due is also left alone: a duplicate message reaching the DLQ must not kill a delivery whose delayed message is still pending. Malformed message → log + `ack`. D1 error → `msg.retry()`.

### 8.3 Pause / Resume — admin API

| Method + path | Behavior | Success |
|---|---|---|
| `POST /destinations/:id/pause` | `active` → `paused`. Already `paused` → no-op. `disabled` → `409 conflict` | `200` destination |
| `POST /destinations/:id/resume` | `paused` → `active`; then move up to 100 of its `paused` deliveries to `pending` and enqueue them as reconcile (a) does. Already `active` → only the delivery move. `disabled` → `409`. Moved deliveries are sent with `sendBatch` and marked `queued`; if the send fails they stay `pending` for reconcile (a) | `200 { destination, resumed: n }` |

- `PATCH /destinations/:id` `status` accepts `active | disabled` from any state. Leftover `paused` deliveries are handled by rules (e)/(e′).
- Ingress may store `pending` for a destination paused less than 30s ago (bundle cache). The consumer's step 3 moves those to `paused`.
- Both endpoints log `admin.destination.paused` / `admin.destination.resumed` (interim audit, M1 §9.2).

### 8.4 Other admin API changes

- `POST`/`PATCH /destinations`: optional `max_attempts` (1–50), `backoff_base_s` (1–3600), `backoff_max_s` (≥ `backoff_base_s` after applying defaults, ≤ 43200). `null` in `PATCH` resets to the default. Responses include all three (raw, nullable).
- `POST`/`PATCH /sources`: `max_body_bytes` 1–10485760.
- `GET /events/:id`: each delivery adds `next_attempt_at`. The body is still never returned.
- Zod schemas live in `@hookflare/shared` as in M1.

## 9. Logging

New events: `delivery.retry_scheduled` (`attempt_no`, `delay_s`), `delivery.dead` (`reason`: `budget` or `dlq`), `delivery.infra_retry` (`stage`, `msg_attempts`), `delivery.reschedule_failed`, `delivery.lease_lost`, `delivery.not_due` (`delay_s`), `reconcile.run`, `reconcile.failed`, plus the ingress events in §6. No payload, secret, or signature is logged.

## 10. Testing

### 10.1 Fault injection — `test/helpers/faults.ts`

Faults wrap the **raw bindings**, and `Deps` is built from the wrapped bindings, so production code has no test hooks.

- `faultyD1(db, rules)` wraps `prepare(...).run/all/first/raw` and `batch`. A rule matches a SQL regex and fails on the n-th match, from the n-th match on, or always.
- `faultyQueue(queue, rules)` for `send` / `sendBatch`.
- `faultyR2(bucket, rules)` for `put` / `get` / `delete`.

### 10.2 Tests

| Area | Tests |
|---|---|
| Backoff | delay bounds per `n` (jitter 0.8–1.2), cap at `backoff_max_s`, clamp to 43200; `Retry-After` delta and HTTP-date, past date, garbage, cap; infra delay sequence |
| Classifier | every row of §7.1 at `n < max` and `n = max` |
| Ingress | > 64 KB → R2 object + `r2_key` + empty `body_inline`; ≤ 64 KB stays inline; 10 MB cap; R2 put failure → `503`, no D1 rows; D1 failure after R2 put → `503` and the object is deleted; queue failure → `503`, delivery `pending`; duplicate → `200`, still one event and one delivery; two concurrent requests → one event, no orphan object; `provider_event_id` NULL → no dedup; paused destination → delivery `paused`, no message |
| Consumer | 408/429/5xx/timeout/network → `retrying` + delayed message + `enqueued_at`; budget exhausted → `dead`; 3xx/4xx → `failed_final`; per-destination `max_attempts`/`backoff_*` honored; `Retry-After` honored; D1/R2/DNS errors → `msg.retry` with no attempt counted; R2 object missing → `failed_final (payload_missing)`; paused destination → `paused`; expired lease is re-acquired; stale worker's record writes nothing (fencing); send OK + record failure → re-sent later with the same `webhook-id`; reschedule send failure → `msg.retry` |
| Reconciler | each rule (a)–(e′); total cap of 500; cooldown prevents re-enqueue on the next run; send OK + update failure; send failure; `next_attempt_at` never moved earlier |
| DLQ | marks non-terminal deliveries `dead`; leaves `paused`, terminal, live-lease, and not-yet-due `retrying` ones; malformed message acked |
| Pause/Resume | state transitions and `409`; resume moves ≤ 100 and returns `resumed`; idempotent pause |
| Migration | seed duplicate `provider_event_id`s with migrations `0001`–`0002`, apply `0003`–`0004`: the earliest event keeps the ID, others are NULL, all deliveries/attempts remain, the unique index exists |
| End to end | backend fails twice then returns `200`: 3 attempts, final `delivered`, the event timeline shows all three |

### 10.3 Exit criteria mapping

| Criterion | Proof |
|---|---|
| Never `202` before D1/R2/Queue writes | Ingress fault tests for R2, D1, and Queue |
| Backend recovers after 48h | Integration test with a fake clock: the backend returns `503` for 48h of simulated time while the test runs the consumer at each `next_attempt_at`; then `200` → `delivered` with `attempt_count ≤ 20`. Repeated manually on the deployed Worker (acceptance checklist). |
| Duplicates | Ingress duplicate + concurrency tests; migration test |
| Reconciler recovers | Reconciler tests + consumer crash simulation (lease left expired → rule (b) → delivered) |
| Tests for D1/Queue failure, timeout, retry, duplicates, SSRF | §10.2 plus the M1 SSRF suite |

## 11. Documentation updates in M2

- **`README.md`:** Getting started adds `wrangler r2 bucket create hookflare-payloads`, `wrangler queues create hookflare-deliveries-dlq`, and the cron trigger; documents Pause/Resume and the retry policy defaults. Mark M2 as done.
- **Roadmap:** record §3.1 deviations (DEC table unchanged); §5 notes `body_inline` stays `NOT NULL` and `backoff_max_s ≤ 43200`.
- **`CLAUDE.md`:** mention the `scheduled` handler and the DLQ consumer in the architecture section.

## 12. Acceptance checklist

- [ ] `pnpm test`, `pnpm lint`, `pnpm typecheck` pass; CI is green, including the drift check.
- [ ] `0003` and `0004` apply on local and remote D1; re-running is a no-op; `0004` contains no table rebuild.
- [ ] A 200 KB webhook returns `202`, is stored in R2, and the backend receives the exact bytes.
- [ ] Sending the same provider event ID twice returns `202` then `200 {duplicate: true}`.
- [ ] With the backend stopped, the delivery goes `retrying` with growing `next_attempt_at`; after restarting the backend it ends `delivered`.
- [ ] Pause → webhook → `paused` → Resume → `delivered`.
- [ ] The cron runs every minute and `reconcile.run` appears in Workers Logs.
- [ ] No payload, secret, signature, or token appears in Workers Logs.
