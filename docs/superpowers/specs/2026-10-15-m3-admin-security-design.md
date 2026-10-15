# M3 — Admin API & Security: Design Spec

> Milestone M3 of the [roadmap](2026-10-14-hookflare-roadmap.md). M2 made delivery reliable, but the admin API is still guarded only by Access and a bootstrap allowlist, writes its audit trail to logs, and cannot replay anything. M3 adds users and RBAC, a durable audit log, event search, failure listing, single and bulk replay, test delivery, and secret rotation for sources and destinations.

## 1. Goal and exit criteria

**Goal:** operators can find any event, see why it failed, and re-deliver it, while every person reaching the admin API is identified, limited to their role, and leaves an audit trail for every change.

**Exit criteria (roadmap, `DESIGN.md` §11):**
1. The admin API is protected by Access and RBAC.
2. Replay works and preserves past history.
3. Every replay is audited.

## 2. Scope

**In scope**
- `users` table, global roles (Admin / Operator / Viewer), bootstrap admin from `BOOTSTRAP_ADMIN_EMAILS`, deny by default.
- Permission-based route guards for every admin route, including the routes that exist since M1/M2.
- `audit_logs`, written in the same D1 batch as the mutation it records; replaces the interim log-only `audit()`.
- `GET /events` (search, filters, cursor pagination), `GET /events/:id/deliveries`, `GET /events/:id/payload`.
- `GET /failures` and `POST /failures/replay` (bulk, ≤ 100), `POST /events/:id/replay` (single).
- Test delivery (`POST /destinations/:id/test`) and its history (`test_deliveries`).
- Secret rotation with a grace window for sources (inbound) and destinations (outbound, dual signatures).
- `GET /me`, `/users` management, `GET /audit-logs`.
- Shared zod schemas and DTOs in `packages/shared` for every new endpoint.

**Out of scope (and the milestone that adds it)**
- `GET /overview` and `stats_hourly` (M4).
- `GET/PATCH /settings` and editable retry defaults (M4).
- `/archives`, `/alerts` (M5); retention of `audit_logs` and `test_deliveries` (M5).
- Per-project RBAC, replay by filter (backlog).
- DELETE for projects, sources, and destinations: they are retired with `status = disabled`, as today.

## 3. Decisions taken in this spec

| # | Topic | Decision | Why |
|---|---|---|---|
| M3-1 | Test delivery storage | A dedicated `test_deliveries` table, not `deliveries`/`delivery_attempts`. | `delivery_attempts → deliveries → webhook_events.source_id NOT NULL`, and a test has no source. Making `source_id` nullable needs a rebuild of the largest table (see M2-3). A separate table also keeps test traffic out of search and stats. |
| M3-2 | Secret rotation model | "Previous + grace window" for both directions. Rotation moves current to `prev`, installs the new secret as current, and sets `prev_expires_at = now + grace_hours` (default 24, range 0–168). | One model for inbound and outbound; no extra promote step to forget. `grace_hours = 0` is an immediate revoke for leaked secrets. |
| M3-3 | Outbound during grace | Sign with both secrets: `webhook-signature: v1,<current> v1,<prev>`. | Standard Webhooks allows several space-separated signatures, so the backend can switch secrets at any moment within the window. |
| M3-4 | Replay target | A replay goes to the destination of the event's **initial** delivery (single replay) or of the selected delivery (bulk), never to the source's current destination. | The source may have been re-pointed since; replay means "re-send what was sent". |
| M3-5 | Bulk replay selection | Explicit `delivery_ids` (≤ 100, deduplicated), each reported as `replayed` or `skipped` with a reason. | Predictable and exactly auditable. Replay-by-filter goes to the backlog. |
| M3-6 | Authorization | Named permissions mapped to roles in `core/rbac.ts`; every route declares `requirePermission(<permission>)`. | Role ordering ("Operator or above") lives in one table, not in each route. |
| M3-7 | Audit atomicity | The audit row is inserted in the **same `db.batch`** as the mutation. Repository mutation helpers return unexecuted statements so routes can compose them. | "Every admin mutation writes `audit_logs`" holds by construction: both commit or neither does. |
| M3-8 | Bootstrap admins | An email in `BOOTSTRAP_ADMIN_EMAILS` with no `users` row is inserted as `admin` on its first request. After that, D1 is the source of truth: a bootstrap admin can be demoted or disabled like any user. | The env var seeds the first admin without becoming a permanent bypass. |
| M3-9 | Last-admin guard | Demoting, disabling, or self-disabling the last active admin returns `409 last_admin`. An admin can never disable themself. | Prevents locking every admin out of the API. |
| M3-10 | Replay and the queue | If `QUEUE.send` fails after the replay rows commit, the endpoint still succeeds and reports `enqueued: false`; reconciler rule (a) enqueues the delivery later. | The rows are durable, and unlike a provider an operator gains nothing from a `503` and a retry, which would create a second replay. |
| M3-11 | Search pagination | Events sort by `(received_at DESC, id DESC)` and failures by `(completed_at DESC, id DESC)`, with an opaque base64 cursor of `(sort key, id)`. | Uses the existing `(project_id, received_at)` / `(source_id, received_at)` indexes and the new `(status, completed_at)` index. |
| M3-12 | Payload access is audited | Each `GET /events/:id/payload` writes `event.payload_viewed`. | A read, but raw payloads are the most sensitive data the gateway holds. |

### 3.1 Deviations from the roadmap and earlier milestones

| Source | Change | Reason |
|---|---|---|
| Roadmap §5 `destinations.signing_secret_next_enc` | Replaced by `signing_secret_prev_enc` + `signing_secret_prev_expires_at`; sources get `secret_prev_enc` + `secret_prev_expires_at` | M3-2 |
| Roadmap §8 "Test delivery … the attempt is still recorded" | Recorded in `test_deliveries`, not `delivery_attempts` | M3-1 |
| Roadmap §8 "REST endpoints follow `DESIGN.md` §7" | `/overview`, `/settings`, `/archives`, `/alerts` are not in M3 | §2 |
| Roadmap §7.1 step 8 (`503` when the queue send fails) | Admin replay answers `enqueued: false` instead | M3-10 |
| Roadmap §5 `users` columns | Adds `updated_at` | Needed for the users list and audit diffs |

## 4. Layout

New and changed files under `apps/gateway/`:

```text
migrations/
└── 0005_admin_security.sql      # generated
src/
├── core/
│   ├── rbac.ts                  # Permission, Role → Permission[] map
│   ├── audit.ts                 # redactDiff(), auditInsert() → statement for db.batch
│   ├── outbound.ts              # sign + fetch + classify, shared by consumer and test delivery
│   ├── secrets.ts               # activeSecrets(row, now), rotate helpers
│   ├── ids.ts                   # + "tst" prefix
│   └── db/
│       ├── schema.ts            # users, audit_logs, test_deliveries, prev secret columns
│       ├── users.ts
│       ├── audit-logs.ts
│       ├── test-deliveries.ts
│       ├── events.ts            # + searchEvents
│       └── deliveries.ts        # + listFailures, replay inserts
├── delivery/consumer.ts         # uses core/outbound.ts, dual signing
├── ingress/verify.ts            # verify with current, then prev within grace
└── admin/
    ├── auth/access.ts           # + users lookup and bootstrap
    ├── auth/permission.ts       # requirePermission()
    ├── cursor.ts                # encode/decode (sort key, id)
    ├── replay.ts                # shared prechecks, batch, enqueue
    ├── http.ts                  # interim audit() removed
    └── routes/
        ├── me.ts  users.ts  failures.ts  audit-logs.ts     # new
        └── events.ts  sources.ts  destinations.ts  projects.ts  # guarded, extended
packages/shared/src/             # zod schemas + DTOs for the new endpoints
```

Module rules are unchanged: `ingress/` must not import from `admin/`; `delivery/` and `jobs/` import from `core/` only. Moving outbound sending into `core/outbound.ts` lets `admin/` run a test delivery without importing `delivery/`.

## 5. Schema — `0005_admin_security.sql` (generated)

**New tables** (all non-`STRICT`, enums as `CHECK`, timestamps in epoch ms):

| Table | Columns | Indexes |
|---|---|---|
| `users` | `email` PK (lowercased), `role` (`admin`/`operator`/`viewer`), `created_at`, `updated_at`, `disabled_at` | — |
| `audit_logs` | `id` (`aud_`), `actor_email`, `action`, `resource_type`, `resource_id`, `reason`, `diff_json`, `at` | `(at)`, `(resource_type, resource_id, at)`, `(actor_email, at)` |
| `test_deliveries` | `id` (`tst_`), `destination_id` FK, `project_id`, `actor_email`, `started_at`, `duration_ms`, `http_status`, `error_kind`, `error_message`, `response_snippet` (≤ 2 KB) | `(destination_id, started_at)` |

`test_deliveries.error_kind` accepts the M2 `ERROR_KINDS` plus `ssrf_blocked`.

**New columns** (nullable, so `ALTER TABLE ADD COLUMN` without a rebuild):
- `sources.secret_prev_enc`, `sources.secret_prev_expires_at`
- `destinations.signing_secret_prev_enc`, `destinations.signing_secret_prev_expires_at`

The pairing rule "both NULL or both set" is enforced in code, not with a `CHECK`, because a table-level `CHECK` forces drizzle-kit into a table rebuild (M2-3).

**New index:** `deliveries(status, completed_at)`.

## 6. Identity and RBAC

### 6.1 Request flow

1. `accessMiddleware` verifies the Access JWT exactly as in M1 (or takes `ACCESS_DEV_EMAIL` on localhost) and normalizes the email.
2. It loads the `users` row. If the row is missing and the email is in `BOOTSTRAP_ADMIN_EMAILS`, it runs one batch: `INSERT … ON CONFLICT DO NOTHING` as `admin` plus audit `user.bootstrapped` (actor = the email itself), then reloads the row.
3. No row, or `disabled_at` set → `403 {error: "forbidden"}`.
4. `c.var.actor = {email, role}`.
5. Each route's `requirePermission(p)` returns `403 {error: "forbidden", required: p}` when the role lacks `p`.

`ACCESS_DEV_EMAIL` goes through steps 2–5 like any other email; it never bypasses RBAC.

### 6.2 Permissions

| Permission | Viewer | Operator | Admin | Covers |
|---|:-:|:-:|:-:|---|
| `events.read` | ✓ | ✓ | ✓ | events, deliveries, attempts, redacted headers, failures, test history, reading projects/sources/destinations |
| `payload.read` | | ✓ | ✓ | `GET /events/:id/payload` |
| `deliveries.replay` | | ✓ | ✓ | single and bulk replay |
| `destinations.operate` | | ✓ | ✓ | pause, resume, test delivery |
| `config.write` | | | ✓ | create/update projects, sources, destinations; policy; rotate secrets |
| `users.manage` | | | ✓ | `/users` |
| `audit.read` | | | ✓ | `/audit-logs` |

### 6.3 Endpoint map

| Method | Path | Permission |
|---|---|---|
| GET | `/me` | (authenticated) |
| GET | `/projects`, `/projects/:id`, `/sources`, `/sources/:id`, `/destinations`, `/destinations/:id` | `events.read` |
| POST/PATCH | `/projects`, `/projects/:id`, `/sources`, `/sources/:id`, `/destinations`, `/destinations/:id` | `config.write` |
| POST | `/sources/:id/rotate-secret`, `/destinations/:id/rotate-secret` | `config.write` |
| POST | `/destinations/:id/pause`, `/destinations/:id/resume`, `/destinations/:id/test` | `destinations.operate` |
| GET | `/destinations/:id/tests` | `events.read` |
| GET | `/events`, `/events/:id`, `/events/:id/deliveries` | `events.read` |
| GET | `/events/:id/payload` | `payload.read` |
| POST | `/events/:id/replay` | `deliveries.replay` |
| GET | `/failures` | `events.read` |
| POST | `/failures/replay` | `deliveries.replay` |
| GET/POST | `/users`; PATCH `/users/:email` | `users.manage` |
| GET | `/audit-logs` | `audit.read` |

All paths are under `/api/admin/v1`.

## 7. Audit log

- **Actions** are `resource.verb`: `project.created|updated`, `source.created|updated|secret_rotated`, `destination.created|updated|paused|resumed|tested|secret_rotated`, `delivery.replayed`, `event.payload_viewed`, `user.bootstrapped|created|role_changed|disabled|enabled`.
- **`reason`** is required (1–500 characters) for single and bulk replay, and optional (≤ 500) for every other mutation, accepted as a `reason` field in the request body.
- **`redactDiff`** runs on every `diff_json`: it drops any key whose name contains `secret`, `token`, or `password` (case-insensitive, at any depth) and reduces destination URLs to their origin (`auditUrl`). Generated or supplied secrets never reach the diff.
- **Atomicity (M3-7):** each mutating route builds its statements plus `auditInsert(...)` and runs one `db.batch`. A failed batch writes neither.
- **`GET /audit-logs`**: filters `actor_email`, `resource_type`, `resource_id`, `action`, `from`, `to`; sorted by `(at DESC, id DESC)`; cursor as in §8.1; `limit` ≤ 100 (default 50).

## 8. Reading events and failures

### 8.1 Cursors

`admin/cursor.ts` encodes `(sortKey: number, id: string)` as base64url JSON. A cursor that does not decode, or whose `id` has the wrong prefix, returns `400 invalid_request` (`path: "cursor"`). The next page uses `(sort_key, id) < (cursor.sortKey, cursor.id)`.

### 8.2 `GET /events`

| Query | Notes |
|---|---|
| `project_id`, `source_id` | Equality |
| `destination_id`, `status` (repeatable) | `EXISTS (SELECT 1 FROM deliveries d WHERE d.event_id = e.id AND …)` |
| `provider_event_id` | Requires `source_id` (`400` otherwise); exact match on the unique index |
| `from`, `to` | Epoch ms on `received_at`, `from` inclusive, `to` exclusive |
| `limit`, `cursor` | `limit` ≤ 100, default 50 |

Each item: `id`, `project_id`, `source_id`, `provider_event_id`, `received_at`, `content_type`, `size_bytes`, and `latest_delivery` (`id`, `kind`, `status`, `attempt_count`) — the delivery with the highest `id` for the event. No headers, no payload.

### 8.3 Event detail, timeline, payload

- `GET /events/:id`: unchanged from M1/M2.
- `GET /events/:id/deliveries`: the `deliveries` array of the detail response (with attempts), for `DESIGN.md` §7.
- `GET /events/:id/payload`: the raw body (inline or R2) with the stored `Content-Type` (default `application/octet-stream`), `Content-Disposition: attachment; filename="<evt_id>"`, `X-Content-Type-Options: nosniff`, and `Cache-Control: no-store`. Missing R2 object → `404 {error: "payload_missing"}`; R2 error → `503`. Order: load the payload (inline, or R2 `get`), then write `event.payload_viewed` (M3-12), then return the body. If the audit write fails the request fails with `503` and no bytes are returned.

### 8.4 `GET /failures`

| Query | Notes |
|---|---|
| `status` | `failed_final`, `dead`, or both (default) |
| `project_id`, `destination_id` | Equality |
| `from`, `to` | On `completed_at` |
| `unresolved` | Default `true`: hides a failure when a newer delivery for the same event and destination is `delivered` |
| `limit`, `cursor` | As in §8.2 |

Sorted by `(completed_at DESC, id DESC)` on the new `deliveries(status, completed_at)` index. Each item carries the delivery fields, the event's `source_id` and `received_at`, and `latest_replay` (`id`, `status`) when a newer `kind = replay` delivery exists for the same event and destination.

## 9. Replay

### 9.1 Requests

- **Single:** `POST /events/:id/replay {reason}`. Target: the destination of the event's `initial` delivery (M3-4). Any event can be replayed, including one already `delivered`.
- **Bulk:** `POST /failures/replay {delivery_ids, reason}`. 1–100 IDs, deduplicated. Each ID must be a `failed_final` or `dead` delivery; target: that delivery's event and destination.

### 9.2 Prechecks (per target)

| Reason | Condition | Single | Bulk |
|---|---|---|---|
| `not_found` | Event or delivery does not exist | `404` | skipped |
| `not_failed` | Selected delivery is not `failed_final`/`dead` | — | skipped |
| `destination_disabled` | Target destination is `disabled` | `409` | skipped |
| `payload_missing` | Payload is in R2 and `head` finds no object | `409` | skipped |
| `replay_in_progress` | A non-terminal `kind = replay` delivery exists for the same event and destination | `409` | skipped |

An R2 error during `head` is a `503` for single replay and fails the whole bulk request with `503` (no rows written), since an infra error must not be reported as a per-item skip.

### 9.3 Write and enqueue

1. One `db.batch`: insert one delivery per replayable target (`kind = replay`, `created_by = actor`, `status = paused` if the destination is paused, else `pending`, `attempt_count = 0`) plus **one** `delivery.replayed` audit row. Its `reason` column holds the operator's reason; its `diff_json` holds `{replayed: [{source_delivery_id, new_delivery_id}], skipped: [{delivery_id, reason}]}`, where `skipped[].reason` is the precheck code from §9.2. For single replay `source_delivery_id` is the initial delivery.
2. If no target is replayable, nothing is written and no audit row is created; the response lists the skips.
3. Non-paused deliveries are sent with one `QUEUE.sendBatch`, then `markQueued` for each. On send failure the response reports `enqueued: false` (M3-10).
4. Response — single: `201 {delivery_id, status, enqueued}`; bulk: `200 {replayed: [{delivery_id, new_delivery_id, enqueued}], skipped: [{delivery_id, reason}]}`.

The `replay_in_progress` check and the insert are not one transaction, so two concurrent requests may both pass the check. The result is at most one extra replay delivery for the same event, which the backend absorbs through `X-Webhook-Event-ID` idempotency. This is accepted rather than adding a uniqueness constraint.

### 9.4 Invariants

- Replay never updates an existing delivery or attempt row.
- A replay delivery follows the M2 pipeline unchanged: lease, retry budget from its own `attempt_count`, backoff, DLQ, reconciler.
- Each replay delivery has its own `webhook-id` (the delivery ID) and the same `X-Webhook-Event-ID`. A backend that deduplicates by event ID, as `DESIGN.md` §8 asks, treats a replay of an event it already processed as a duplicate; that is intended.

## 10. Test delivery

**`POST /destinations/:id/test {payload?, reason?}`** runs synchronously:

1. Destination `disabled` → `409 destination_disabled`. `paused` is allowed: testing is how an operator checks a backend before Resume.
2. Body: the supplied `payload` (any JSON, serialized ≤ 64 KB) or the default `{"type":"hookflare.test","destination_id":"<dst_id>","timestamp":<ms>}`; `Content-Type: application/json`.
3. SSRF check (`checkUrl`). Blocked → recorded with `error_kind = ssrf_blocked`, no request sent. Resolver error → `503`, nothing recorded.
4. Sign and send through `core/outbound.ts` with the destination's `timeout_ms`, `redirect: "manual"`, `webhook-id = tst_…`, and dual signatures during grace (M3-3). No `X-Webhook-Event-ID`, since there is no event.
5. One `db.batch`: insert `test_deliveries` + audit `destination.tested` (`diff_json`: `test_delivery_id`, `http_status`, `error_kind`).
6. `200 {id, http_status, duration_ms, error_kind, error_message, response_snippet}`, whatever the backend answered.

Tests never touch `deliveries`, the queue, the retry budget, or the limiter. **`GET /destinations/:id/tests`** lists them by `(started_at DESC, id DESC)` with a cursor.

## 11. Secret rotation

### 11.1 Sources (inbound)

**`POST /sources/:id/rotate-secret {grace_hours?, secret?, reason?}`**
- `auth_type = none` → `409 no_secret`.
- `secret` supplied (16–512 characters) is used as is, for providers that generate their own secret. Otherwise the gateway generates one as at creation. A generated secret is returned **once** in the response; a supplied one is never echoed.
- `grace_hours`: integer 0–168, default 24.
- Ingress verification: current secret first; on mismatch, the previous secret when `secret_prev_expires_at > now`. Both comparisons are constant-time. A match on the previous secret logs `ingress.verified_with_prev_secret` so operators can see whether the provider has switched.

### 11.2 Destinations (outbound)

**`POST /destinations/:id/rotate-secret {grace_hours?, reason?}`**: always generates a new `whsec_` secret and returns it once. While the previous secret is within grace, the consumer and test delivery send `webhook-signature: v1,<sig with current> v1,<sig with prev>`.

### 11.3 Common rules

- **Re-encryption:** the current secret is decrypted and re-encrypted under the AAD of the prev column (`sources.secret_prev_enc:<id>`, `destinations.signing_secret_prev_enc:<id>`), since AAD binds ciphertext to its column.
- **One prev at a time:** rotating again during a grace window drops the older prev immediately.
- **`grace_hours = 0`:** clears the prev columns instead of storing an already-expired secret.
- **Expiry:** `core/secrets.ts` `activeSecrets(row, now)` ignores an expired prev. Expired columns are cleared lazily on the next rotate or update of that row; no job is needed.
- **DTOs** gain `previous_secret_fingerprint` and `previous_secret_expires_at` (null when no prev is active).
- **Audit:** `source.secret_rotated` / `destination.secret_rotated` with `{grace_hours, prev_expires_at, new_fingerprint}`. (`previous_secret_expires_at` would be dropped by the redactor, whose key pattern matches `secret`.)

## 12. Users and `/me`

- **`GET /me`** → `{email, role, permissions}` for any active user. The dashboard (M4) uses it to show or hide actions.
- **`GET /users`**: sorted by email, cursor = last email.
- **`POST /users {email, role}`**: email lowercased and validated; existing email → `409 user_exists`.
- **`PATCH /users/:email {role?, disabled?, reason?}`**: `disabled: true` sets `disabled_at`, `false` clears it. Audited as `user.role_changed`, `user.disabled`, or `user.enabled`. The last-admin guard (M3-9) applies.
- No DELETE: audit rows keep pointing at a known user.

A disabled or demoted user's next request sees the change immediately, because the `users` row is read on every request (no cache). This is one indexed primary-key read per admin request.

## 13. Errors

Admin errors keep the M1 shape `{error, ...}`. New codes: `forbidden` (`required`), `last_admin`, `user_exists`, `no_secret`, `destination_disabled`, `payload_missing`, `replay_in_progress`. Invalid input stays `400 invalid_request` with `issues`.

## 14. Testing

### 14.1 Unit
- Role → permission map matches §6.2 exactly.
- `redactDiff`: nested keys, mixed case, arrays, URLs.
- Cursor round-trip; corrupted or wrong-prefix cursors rejected.
- `activeSecrets` before, at, and after `prev_expires_at`.
- Dual-signature header format; each signature verifies with its own secret.
- Inbound HMAC and token verification against current, prev, and expired prev.
- Last-admin guard decisions.

### 14.2 Integration (`@cloudflare/vitest-plugin`)
- **RBAC matrix:** a table-driven test calls every route in §6.3 with each role and asserts `403` exactly where §6.2 denies access.
- **Route coverage:** a test walks the Hono router and fails if any admin route is registered without `requirePermission` (except `/me`).
- Bootstrap on first request; a disabled user gets `403`; `ACCESS_DEV_EMAIL` without a `users` row and not in the bootstrap list gets `403`.
- Event search: each filter, `provider_event_id` without `source_id` → `400`, pagination across equal `received_at` values.
- Failures: `unresolved` hides a failure after a successful replay and shows `latest_replay` while it runs.
- Replay: active, paused, and disabled destinations; missing R2 payload; `replay_in_progress`; bulk with duplicate, unknown, and non-failed IDs; queue failure → `enqueued: false`, then a reconcile run enqueues it.
- **History preserved:** snapshot every delivery and attempt of an event, replay, run the consumer, and assert the snapshot rows are unchanged.
- **Every replay audited:** single and bulk each write exactly one `delivery.replayed` row with the actor and reason.
- Test delivery: 2xx, 5xx, timeout, SSRF-blocked; paused destination allowed; disabled rejected; two signatures present during grace.
- Rotation: inbound accepts prev before expiry and rejects it after (advancing `deps.now`); `grace_hours = 0` revokes immediately; rotating twice drops the older prev.
- Payload endpoint: Viewer `403`, Operator receives bytes and an audit row is written.

### 14.3 Fault injection
- A failing `db.batch` on a mutation leaves neither the change nor the audit row.
- R2 failure during replay `head` → `503` with no rows written.

### 14.4 Exit criteria mapping

| Exit criterion | Tests |
|---|---|
| Admin API protected by Access and RBAC | RBAC matrix, route coverage, M1 Access tests |
| Replay works and preserves history | Replay suite, history-preserved snapshot test |
| Every replay is audited | Every-replay-audited test |

## 15. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Sparse `status`/`destination_id` filters on `GET /events` scan many events | Slow queries on large projects | `limit` ≤ 100; encourage `from`/`to`; measure in the M6 benchmark and add a denormalized column if needed |
| Source cache TTL (30 s) after a `grace_hours = 0` rotation | A leaked inbound secret is still accepted by warm isolates for up to 30 s | Accepted and documented in the runbook (M6) |
| Concurrent replays of the same target | One extra delivery | Backend idempotency by `X-Webhook-Event-ID` (§9.3) |
| `audit_logs` and `test_deliveries` grow without bound | D1 size | Retention and archival in M5 (`audit_retention_days`) |
