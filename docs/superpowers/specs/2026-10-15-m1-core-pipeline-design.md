# M1 — Core Pipeline: Design Spec

> Milestone M1 of the [roadmap](2026-10-14-hookflare-roadmap.md). M1 builds the first end-to-end path: a provider posts a webhook, the gateway verifies and stores it, enqueues a delivery, and a consumer signs and sends it to the backend once. Retries, leases, reconciliation, idempotency, and R2 payloads are M2.

## 1. Goal and exit criteria

**Goal:** a webhook sent to `/in/:sourceId` is durably stored in D1 and delivered once to its destination with a Standard Webhooks signature, and every delivery outcome is recorded.

**Exit criteria (roadmap, `DESIGN.md` §11):**
1. The gateway still receives and stores webhooks while the backend is offline.
2. Every delivery records its HTTP status, latency, and errors.

## 2. Scope

**In scope**
- D1 schema for `projects`, `sources`, `destinations`, `webhook_events`, `deliveries`, `delivery_attempts`, managed with Drizzle ORM.
- Ingress `POST /in/:sourceId` per roadmap §7.1, with inline payloads only (≤ 64 KB) and `none`/`hmac`/`token` auth.
- Provider event ID extraction (stored, not deduplicated).
- Queue producer + a single-shot delivery consumer with a minimal claim.
- Standard Webhooks signing and the SSRF guard.
- Attempt logging.
- Cloudflare Access JWT verification + `BOOTSTRAP_ADMIN_EMAILS` for a minimal admin API: create, read, and patch projects/sources/destinations, and read an event with its deliveries and attempts.
- `packages/shared` with the zod request/response schemas.

**Out of scope (and the milestone that adds it)**
- Retry policy, backoff, `lease_until`, retry budget, `dead`, DLQ and DLQ consumer, reconciler, Pause/Resume, per-destination `max_attempts`/`backoff_*` (M2).
- Deduplication by provider event ID and the `UNIQUE` index (M2).
- R2 payloads > 64 KB (M2). In M1 they return `413`.
- `users` table, RBAC, `audit_logs`, replay, test delivery, secret rotation, event search (M3).
- Concurrency/rate limits per destination (`DestinationLimiter`, M5).
- Provider presets with timestamped signatures (backlog).

## 3. Decisions taken in this spec

| # | Topic | Decision | Why |
|---|---|---|---|
| M1-1 | Admin auth | Verify the Access JWT (`Cf-Access-Jwt-Assertion`, JWKS, `aud`, `iss`) in M1 and allow only `BOOTSTRAP_ADMIN_EMAILS`. RBAC stays in M3. | Secure by default; M3 reuses the middleware unchanged and only swaps the allow-list for `users`. |
| M1-2 | Provider event ID | Extracted and stored in `webhook_events.provider_event_id`; no dedup and no `UNIQUE` index. | Source config is complete from day one; M2 only adds behavior. |
| M1-3 | Admin API surface | `POST`, `GET` (list and by id), `PATCH` for projects/sources/destinations, plus `GET /events/:id`. `PATCH` never changes secrets. | Enough to run and fix a real pipeline without direct D1 access. |
| M1-4 | Data access | Drizzle ORM (`drizzle-orm/d1`) for schema and queries. | Typed schema and queries. |
| M1-5 | Migrations | `drizzle-kit generate` writes SQL into `apps/gateway/migrations/`; `wrangler d1 migrations apply` still applies them. New tables are not `STRICT`; enum columns use `CHECK` constraints. CI fails on schema/migration drift. | Keeps M0's migration commands and expand → deploy → contract rule; avoids hand-editing generated files. |

### 3.1 Deviations from the roadmap and M0

| Source | Change | Reason |
|---|---|---|
| Roadmap DEC-8 (stack) | Adds Drizzle ORM + drizzle-kit | M1-4 |
| M0 §9 "`STRICT` tables" | New tables are not `STRICT`; `CHECK` constraints on enum columns | M1-5: drizzle-kit cannot emit `STRICT`, and its snapshot does not track it |
| Roadmap §5 indexes | Adds `deliveries(event_id)` | `GET /events/:id` reads deliveries by event |
| Roadmap §5 columns | M1 creates only the columns M1 reads or writes (§5). M2 adds the rest with additive migrations | YAGNI; `ALTER TABLE … ADD COLUMN` is cheap |
| Roadmap §6 lease | M1 uses a minimal claim without `lease_until` (§7.2) | The full lease belongs to M2 |
| Roadmap §11 (DoH errors retryable) | In M1, a resolver error is `failed_final (dns_error)` | M1 has no retries; M2 makes it retryable |

## 4. Layout

```text
packages/shared/                      # @hookflare/shared
└── src/
    ├── admin.ts                      # zod schemas: requests + responses of the admin API
    └── index.ts
apps/gateway/
├── drizzle.config.ts                 # dialect sqlite, schema core/db/schema.ts, out migrations/
├── migrations/
│   ├── 0001_settings.sql             # M0, unchanged
│   ├── 0002_core_pipeline.sql        # generated
│   └── meta/                         # drizzle-kit snapshots + journal (ignored by wrangler)
└── src/
    ├── index.ts                      # { fetch, queue }
    ├── app.ts                        # mounts /healthz, /in, /api/admin/v1
    ├── deps.ts                       # Deps type + createDeps(env)
    ├── core/
    │   ├── db/schema.ts              # Drizzle schema (incl. the M0 `settings` table)
    │   ├── db/*.ts                   # query functions per aggregate
    │   ├── source-cache.ts           # 30s isolate cache of source bundles
    │   ├── ssrf.ts
    │   └── ids.ts · crypto.ts · log.ts (M0)
    ├── ingress/
    │   ├── route.ts
    │   ├── body.ts                   # capped body reader
    │   ├── verify.ts                 # Verifier interface + none/hmac/token
    │   └── event-id.ts
    ├── delivery/
    │   ├── consumer.ts
    │   ├── sign.ts                   # Standard Webhooks
    │   └── classify.ts
    └── admin/
        ├── auth/access.ts
        └── routes/{projects,sources,destinations,events}.ts
```

`ingress/` must not import from `admin/`: a Biome `noRestrictedImports` rule enforces it from M1. Shared code lives in `core/`.

### 4.1 Dependency seam — `deps.ts`

```ts
type Deps = {
  db: DrizzleD1Database<typeof schema>;
  queue: Queue<DeliveryMessage>;          // DeliveryMessage = { deliveryId: string }
  fetch: typeof fetch;                    // outbound calls to backends
  resolveDns: (host: string) => Promise<string[]>; // DoH, A + AAAA
  now: () => number;                      // epoch ms
  env: Env;                               // secrets + vars
};
```

Ingress, consumer, and admin handlers receive `Deps` and never touch `env.DB`/`env.QUEUE`/global `fetch` directly. Tests replace `fetch` and `resolveDns`; M2 wraps `db` and `queue` for fault injection.

## 5. Schema — `migrations/0002_core_pipeline.sql`

Generated from `core/db/schema.ts`. Conventions from M0 still apply (epoch-ms `INTEGER` timestamps, prefixed ULIDs as primary keys, one migration per milestone change), except `STRICT` (§3.1).

**`CHECK` constraints list every value the roadmap defines now, including values M1 never writes**, because changing a `CHECK` in SQLite requires rebuilding the table.

| Table | Columns | Notes |
|---|---|---|
| `projects` | `id`, `name`, `slug`, `status`, `created_at`, `updated_at` | `slug` UNIQUE, `^[a-z0-9][a-z0-9-]{1,62}$`. `status ∈ {active, disabled}` |
| `destinations` | `id`, `project_id`, `name`, `url`, `status`, `signing_secret_enc`, `timeout_ms`, `created_at`, `updated_at` | `status ∈ {active, paused, disabled}`. `timeout_ms` NULL → default 10000 |
| `sources` | `id`, `project_id`, `destination_id`, `name`, `status`, `auth_type`, `auth_config`, `secret_enc`, `event_id_from`, `event_id_selector`, `max_body_bytes`, `created_at`, `updated_at` | `status ∈ {active, disabled}`. `auth_type ∈ {none, hmac, token}`. `auth_config` is JSON text. `secret_enc` NULL iff `auth_type = none`. `event_id_from ∈ {none, header, json_path}`. `max_body_bytes` NULL → default |
| `webhook_events` | `id`, `project_id`, `source_id`, `provider_event_id`, `received_at`, `headers_json`, `content_type`, `size_bytes`, `payload_sha256`, `body_inline` | `body_inline` BLOB NOT NULL in M1 (M2 makes it nullable when adding `r2_key`) |
| `deliveries` | `id`, `event_id`, `destination_id`, `project_id`, `kind`, `status`, `attempt_count`, `enqueued_at`, `last_http_status`, `last_error`, `completed_at`, `created_by`, `created_at` | `kind ∈ {initial, replay, test}`. `status ∈ {pending, queued, in_flight, retrying, paused, delivered, failed_final, dead}`. `created_by` is `NULL` for ingress |
| `delivery_attempts` | `id`, `delivery_id`, `attempt_no`, `started_at`, `duration_ms`, `http_status`, `error_kind`, `error_message`, `response_snippet` | `UNIQUE(delivery_id, attempt_no)`. `error_kind ∈ {http_3xx, http_4xx, http_5xx, timeout, network}` or NULL on 2xx |

**Foreign keys:** `destinations.project_id → projects.id`, `sources.project_id → projects.id`, `sources.destination_id → destinations.id`, `webhook_events.source_id → sources.id`, `deliveries.event_id → webhook_events.id`, `deliveries.destination_id → destinations.id`, `delivery_attempts.delivery_id → deliveries.id`. No cascades: M1 never deletes rows.

**Indexes:** `webhook_events(source_id, received_at)`, `webhook_events(project_id, received_at)`, `webhook_events(source_id, provider_event_id)` (non-unique; M2 replaces it with the partial `UNIQUE`), `deliveries(event_id)`, `deliveries(destination_id, created_at)`.

**Baseline.** `settings` (from `0001`) is declared in `schema.ts` so Drizzle knows about it, but `0002` must not recreate it. The implementation plan records how the baseline snapshot is produced; the acceptance check is that `0002` contains no `CREATE TABLE settings` and migration file names continue the `NNNN_<topic>.sql` sequence.

**M2 data risk.** Because M1 stores `provider_event_id` without a unique index, M2's migration must deduplicate existing rows before creating the `UNIQUE` index, or index creation fails.

### 5.1 Secrets

| Secret | Origin | Stored as | AAD context |
|---|---|---|---|
| Destination signing secret | Always generated: `whsec_` + base64(32 random bytes) | `destinations.signing_secret_enc` | `destinations.signing_secret_enc:<dst_id>` |
| Source secret (`hmac`, `token`) | Supplied in the request (providers such as Stripe issue their own), or generated (32 random bytes, base64url) | `sources.secret_enc` | `sources.secret_enc:<src_id>` |

A secret appears in plaintext only in the `POST` response that created it (and only when it was generated, for sources). Every other read returns `*_fingerprint` (`secretFingerprint`, M0 §8.2).

## 6. Ingress — `POST /in/:sourceId`

Bindings added in `wrangler.jsonc`: queue producer `QUEUE` → `hookflare-deliveries`; ratelimit `INGRESS_LIMITER` (`simple: { limit: 100, period: 10 }`).

| Step | Behavior | Response on failure |
|---|---|---|
| 1. Load bundle | Source + destination + project via `core/source-cache.ts` (isolate cache, 30s TTL, also caches "not found" for 30s). Source missing, source `disabled`, or project `disabled` → reject. A `disabled` destination does not block ingress (the consumer handles it). | `404 {"error":"not_found"}` |
| 2. Rate limit | `INGRESS_LIMITER.limit({ key: sourceId })` | `429 {"error":"rate_limited"}` |
| 3. Body cap | Cap = `min(max_body_bytes ?? 1_048_576, 65_536)`. Reject early if `Content-Length` exceeds the cap; otherwise read the stream and abort as soon as the cap is exceeded. | `413 {"error":"payload_too_large"}` |
| 4. Verify | On the raw bytes (§6.1). | `401 {"error":"unauthorized"}` |
| 5. Event ID | §6.2. Never rejects. | — |
| 6. Prepare | `payload_sha256` = hex SHA-256 of the body. `headers_json` = `redactHeaders(headers, [source auth header])`. `content_type` from the request. | — |
| 7. D1 batch | `db.batch([insert webhook_events, insert deliveries(status='pending', kind='initial')])`. | `503 {"error":"unavailable"}` |
| 8. Enqueue | `deps.queue.send({ deliveryId })`. | `503 {"error":"unavailable"}` |
| 9. Mark queued | Best effort: `UPDATE deliveries SET status='queued', enqueued_at=:now WHERE id=:id AND status='pending'`. A failure is logged and ignored. | — |
| 10. Accept | `202 {"event_id":"evt_…"}` | — |

Log lines: `ingress.accepted`, `ingress.rejected` (with `reason`: `not_found`/`rate_limited`/`too_large`/`unauthorized`), `ingress.store_failed`, `ingress.enqueue_failed`, `ingress.mark_queued_failed`.

**Known M1 limitation.** If step 7 succeeds and step 8 fails, the delivery stays `pending` until M2's reconciler exists. The provider gets `503` and usually retries, which creates a second event because M1 does not deduplicate. This is acceptable for M1 and closed by M2.

### 6.1 Verifiers — `ingress/verify.ts`

```ts
interface Verifier {
  verify(input: { headers: Headers; url: URL; body: Uint8Array; config: AuthConfig; secret: string | null }): Promise<boolean>;
}
```

| `auth_type` | `auth_config` | Check |
|---|---|---|
| `none` | `{}` | Always passes |
| `hmac` | `{ header, algorithm: "sha1" \| "sha256" \| "sha512", encoding: "hex" \| "base64", prefix?: string }` | Read `header`; strip `prefix` if configured (missing prefix → fail); decode with `encoding` (hex is case-insensitive); compare with HMAC(secret, body) |
| `token` | `{ in: "header" \| "query", name }` | Read the header or query parameter `name`; compare with the secret |

- All comparisons use `crypto.subtle.timingSafeEqual`. Inputs of unequal length fail without calling it.
- Every failure returns the same `401`; the reason (`missing_header`, `bad_encoding`, `mismatch`, …) is only logged.
- The signature/token header name is added to the redaction list for that request. A `token` in the query string is never stored (the URL is not stored).

### 6.2 Provider event ID — `ingress/event-id.ts`

- `event_id_from = header`: the value of header `event_id_selector`.
- `event_id_from = json_path`: JSON is parsed only after verification. Selector syntax is a subset: `$` followed by `.key` and `[index]` segments (e.g. `$.id`, `$.data.object.id`, `$.items[0].id`). Strings are used as is; finite numbers are converted with `String()`; anything else is `NULL`.
- The value is `NULL` when the header/path is missing, the body is not valid JSON, or the value is empty or longer than 256 characters. Extraction never rejects a webhook.

## 7. Delivery consumer — `delivery/consumer.ts`

Consumer config for `hookflare-deliveries`: `max_batch_size: 10`, `max_retries: 10`, `retry_delay: 30`. No DLQ in M1. Messages in a batch are processed concurrently; each one is acked or retried on its own.

| Step | Behavior | Message outcome |
|---|---|---|
| 1. Load | Delivery + event + destination by `deliveryId`. Delivery not found → log `delivery.not_found`. | not found: `ack`. D1 error: `retry()` |
| 2. Already handled | Status not in `{pending, queued}` → skip (duplicate message or terminal delivery). | `ack` |
| 3. Destination `disabled` | Conditional update to `failed_final`, `last_error='destination_disabled'`, `completed_at`. No attempt row. | `ack` |
| 4. SSRF | `checkUrl(destination.url, deps)` (§8). Blocked → `failed_final`, `last_error='ssrf_blocked: <reason>'`; resolver error → `failed_final`, `last_error='dns_error'`. No attempt row. | `ack` |
| 5. Claim | `UPDATE deliveries SET status='in_flight' WHERE id=:id AND status IN ('pending','queued')`. 0 rows → skip. | 0 rows: `ack` |
| 6. Send | Decrypt the signing secret, sign (§7.1), `deps.fetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(timeout_ms) })`. Read at most 2 KB of the response body (UTF-8, lossy) as `response_snippet`, then cancel the stream. | — |
| 7. Record | `db.batch([insert delivery_attempts(attempt_no = attempt_count + 1, …), update deliveries(attempt_count + 1, status, last_http_status, last_error, completed_at)])`. | success: `ack`. D1 error: `retry()` |

Steps 3–4 also use a conditional update (`WHERE status IN ('pending','queued')`) so they never overwrite a delivery another consumer already handled.

### 7.1 Outbound request — `delivery/sign.ts`

- Body: the stored raw bytes, unchanged.
- Headers: the stored (already redacted) headers minus hop-by-hop headers (`connection`, `keep-alive`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `host`, `content-length`), with the stored `content-type`, plus:
  - `webhook-id`: the delivery ID (`dlv_…`). It stays the same for every attempt of one delivery; a replay (M3) is a new delivery and therefore gets a new `webhook-id`, so backends that deduplicate on it still process replays.
  - `webhook-timestamp`: current time in seconds.
  - `webhook-signature`: `v1,` + base64(HMAC-SHA256(key, `${webhook-id}.${webhook-timestamp}.` ‖ body)), where `key` is the base64-decoded part after `whsec_`.
  - `X-Webhook-Event-ID`: the event ID (`evt_…`), for backends that deduplicate logical events.
  - `user-agent: Hookflare/1`.

### 7.2 Classification — `delivery/classify.ts`

| Result | Delivery status | `error_kind` |
|---|---|---|
| 2xx | `delivered` | NULL |
| 3xx (not followed) | `failed_final` | `http_3xx` |
| 4xx | `failed_final` | `http_4xx` |
| 5xx | `failed_final` | `http_5xx` |
| `AbortSignal.timeout` fired | `failed_final` | `timeout` |
| Any other fetch exception | `failed_final` | `network` |

`last_error` / `error_message` hold a short, non-sensitive description (`HTTP 503`, `timeout after 10000 ms`, the exception name and message). `duration_ms` covers fetch start to the end of the snippet read. The classifier is a pure function so M2 can extend it with retryable outcomes.

**Known M1 limitation.** If the Worker crashes after step 5, or step 7 fails, the delivery stays `in_flight`: the retried message finds no claimable row and is acked. M2's `lease_until` and reconciler (b) recover such deliveries.

## 8. SSRF guard — `core/ssrf.ts`

`checkUrl(url, deps) → { ok: true } | { ok: false, reason } | throws DnsError`

1. **Static checks:** parse with `URL`; scheme must be `https:`; no username/password; hostname must not be an IP literal (after `URL` normalization, so decimal/hex/short IPv4 forms are caught); hostname must not be `localhost`, end in `.localhost`, `.local`, or `.internal`, or be a known metadata host (`metadata.google.internal`, `metadata`, `instance-data`).
2. **DNS:** `deps.resolveDns(host)` queries `https://cloudflare-dns.com/dns-query` (`accept: application/dns-json`) for `A` and `AAAA`, following CNAMEs as returned in the answer. No addresses → blocked (`no_records`). A non-`NOERROR`/`NXDOMAIN` status or a network error → `DnsError`. `NXDOMAIN` → blocked.
3. **Ranges:** blocked if **any** resolved address is in: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`, `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, `ff00::/8`; IPv4-mapped (`::ffff:0:0/96`) and NAT64 (`64:ff9b::/96`) addresses are checked by their embedded IPv4 address.
4. **Cache:** results (allowed or blocked, not errors) are cached per isolate for 60 seconds, keyed by hostname.

Called when a destination is created or its `url` is patched (blocked → `422 {"error":"unsafe_url","reason":…}`; `DnsError` → `503`), and before every delivery (§7 step 4).

**Residual risk:** DNS rebinding between the check and `fetch`, because Workers cannot pin the resolved IP. Accepted and documented; Cloudflare's own egress restrictions are a second layer.

## 9. Admin API — `/api/admin/v1`

### 9.1 Access middleware — `admin/auth/access.ts`

New vars in `wrangler.jsonc`: `ACCESS_TEAM_DOMAIN` (e.g. `https://<team>.cloudflareaccess.com`), `ACCESS_AUD`, `BOOTSTRAP_ADMIN_EMAILS` (comma-separated). They are not secrets.

1. If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is empty and the dev bypass does not apply → `500 {"error":"internal_error"}`, logged as `admin.access_misconfigured`. The API **fails closed**.
2. Read `Cf-Access-Jwt-Assertion`. Missing → `401 {"error":"unauthorized"}`.
3. Verify with `jose`: RS256, keys from `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` (`createRemoteJWKSet`, cached per isolate; refetch on unknown `kid` at most once per minute), `audience: ACCESS_AUD`, `issuer: ACCESS_TEAM_DOMAIN`, `clockTolerance: 60s`. Failure → `401`.
4. Lowercase the `email` claim and match it against `BOOTSTRAP_ADMIN_EMAILS` (trimmed, lowercased). No email (service tokens) or not listed → `403 {"error":"forbidden"}`.
5. Set `c.var.actor = { email }`.

**Local dev bypass:** when `ACCESS_DEV_EMAIL` is set (only in `.dev.vars`) **and** the request hostname is `localhost` or `127.0.0.1`, steps 2–3 are skipped and that email goes through step 4. Tests do not use the bypass; they sign JWTs with a test key pair and inject its JWKS.

### 9.2 Endpoints

| Method + path | Body / query | Success |
|---|---|---|
| `POST /projects` | `{ name, slug }` | `201` project |
| `GET /projects` | `?limit&cursor` | `200 { data, next_cursor }` |
| `GET /projects/:id` | — | `200` project |
| `PATCH /projects/:id` | `{ name?, status? }` | `200` project |
| `POST /destinations` | `{ project_id, name, url, timeout_ms? }` | `201` destination + `signing_secret` (once) |
| `GET /destinations` | `?project_id&limit&cursor` | `200 { data, next_cursor }` |
| `GET /destinations/:id` | — | `200` destination (`signing_secret_fingerprint`) |
| `PATCH /destinations/:id` | `{ name?, url?, status?: "active" \| "disabled", timeout_ms? }` | `200` destination |
| `POST /sources` | `{ project_id, destination_id, name, auth_type, auth_config, secret?, event_id_from?, event_id_selector?, max_body_bytes? }` | `201` source + `ingress_url` + `secret` (once, only if generated) |
| `GET /sources` | `?project_id&limit&cursor` | `200 { data, next_cursor }` |
| `GET /sources/:id` | — | `200` source (`secret_fingerprint`, `ingress_url`) |
| `PATCH /sources/:id` | `{ name?, status?, destination_id?, auth_config?, event_id_from?, event_id_selector?, max_body_bytes? }` | `200` source |
| `GET /events/:id` | — | `200` event (redacted headers, no body) + `deliveries[]`, each with `attempts[]` |

**Validation rules** (zod, in `@hookflare/shared`):
- `timeout_ms`: 1000–30000. `max_body_bytes`: 1–65536 in M1. `name`: 1–100 characters.
- `secret` is forbidden when `auth_type = none` and, when given, must be 16–512 characters.
- `auth_config` must match the schema of `auth_type` (§6.1). `PATCH` cannot change `auth_type` or any secret (rotation is M3).
- `event_id_selector` is required when `event_id_from ≠ none` and must parse as the §6.2 path syntax for `json_path`.
- A source's `destination_id` must belong to the same `project_id`.
- Creating a destination or source in a `disabled` project is allowed (it is only unreachable by ingress).
- `status: "paused"` is rejected for destinations in M1.

**Conventions:**
- Lists are ordered by `id` descending. `limit` defaults to 50, max 200. `cursor` is the last `id` of the previous page; `next_cursor` is `null` on the last page.
- Errors: `400 {"error":"invalid_request","issues":[…]}`, `404 not_found`, `409 conflict` (duplicate `slug`), `422 unsafe_url`, `422 invalid_reference` (unknown or cross-project `project_id`/`destination_id`).
- Responses never contain `*_enc` columns. `GET /events/:id` never contains the body; raw payload viewing is an Operator permission in M3.
- **Interim audit.** Every successful mutation logs `admin.<resource>.<created|updated>` with `actor_email`, `resource_id`, and a redacted `diff`. M3 replaces this with `audit_logs`.
- **Cache staleness.** Ingress may use a source bundle up to 30 seconds old after a `PATCH`. This is documented in the API docs; M1 does not invalidate caches actively.

## 10. Testing

The Vitest setup from M0 is reused; `wrangler.jsonc` now also declares the queue and ratelimit bindings, which Miniflare provides locally. Tests build `Deps` with real D1 and Queue bindings and stubbed `fetch`, `resolveDns`, and `now`.

| Area | Tests |
|---|---|
| Verifiers | `hmac` for each algorithm × encoding, with and without prefix, wrong prefix, wrong signature, missing header, length mismatch; `token` via header and query; `none` |
| Event ID | header; `$.id`, nested path, array index; invalid JSON, missing path, non-scalar value, value > 256 chars → `NULL` |
| Body reader | `Content-Length` over the cap; lying/missing `Content-Length` with a stream over the cap; exactly at the cap |
| Signing | matches the Standard Webhooks reference test vector |
| SSRF | `http:`, userinfo, IPv4/IPv6 literals incl. decimal/hex forms, `localhost`/`*.internal`/metadata hosts; one address per blocked range; a bad address mixed with good ones; IPv4-mapped and NAT64; no records; NXDOMAIN; resolver error → `DnsError`; cache hit |
| Classifier | 2xx, 3xx, 4xx, 5xx, timeout, network |
| Access | valid JWT; wrong `aud`; wrong `iss`; expired; unknown `kid` triggers one refetch; email not listed; service token (no email); missing config fails closed; dev bypass works only on `localhost` |
| Ingress (integration) | happy path → `202`, rows in D1, one queue message, status `queued`; `404`/`429`/`413`/`401`; stored headers are redacted; D1 failure → `503`; `queue.send` failure → `503` with the delivery left `pending` |
| Consumer (integration) | 2xx → `delivered` with an attempt holding `http_status` and `duration_ms`; 500/timeout/network → `failed_final` with `error_kind`; 3xx is not followed; SSRF-blocked and `disabled` destinations write no attempt; a duplicate message calls `fetch` exactly once; outbound headers carry a valid signature and no denylisted header |
| Admin (integration) | create/list/get/patch per resource; secrets returned once, then only fingerprints; `409`, `422 unsafe_url`, `422 invalid_reference`, `400`; `401`/`403` |
| End to end | create project → destination → source via the API, `POST /in/:id`, run the consumer, `GET /events/:id` shows a `delivered` delivery with one attempt |

**Exit criteria mapping**

| Criterion | Proof |
|---|---|
| Receives and stores while the backend is offline | Integration test with `fetch` failing: ingress returns `202`, the event is in D1, the delivery ends `failed_final` with `error_kind=network`. Repeated on the deployed Worker (acceptance checklist). |
| Every delivery records HTTP status, latency, errors | Consumer tests assert every attempt and delivery column for each outcome in §7.2 |

## 11. Tooling and CI

- New dependencies: `drizzle-orm`, `jose`, `zod`, `@hono/zod-validator` (gateway); `drizzle-kit` (dev); `zod` (shared). Latest stable, locked by `pnpm-lock.yaml`.
- Root script `pnpm db:generate` → `drizzle-kit generate --config apps/gateway/drizzle.config.ts`.
- CI adds, after `cf-typegen`: `pnpm db:generate` then `git diff --exit-code apps/gateway/migrations`, failing on schema/migration drift.
- Biome `noRestrictedImports`: files under `apps/gateway/src/ingress/` may not import `../admin/*`.

## 12. Documentation updates in M1

- **`README.md`:** Getting started adds `wrangler queues create hookflare-deliveries`, the ratelimit namespace, the Access vars (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `BOOTSTRAP_ADMIN_EMAILS`), `ACCESS_DEV_EMAIL` in `.dev.vars.example`, and a `curl` walkthrough that creates a project, destination, and source and sends a signed webhook. Mark M1 as done in the roadmap table.
- **`CLAUDE.md`:** add `pnpm db:generate` to Commands; mention Drizzle in the architecture section.
- **Roadmap:** DEC-8 adds Drizzle; §5 notes "no `STRICT`, `CHECK` constraints" and the `deliveries(event_id)` index; M2 scope notes the provider-event-ID dedup migration risk (§5).

## 13. Acceptance checklist

- [ ] `pnpm test`, `pnpm lint`, `pnpm typecheck` pass; CI is green, including the drift check.
- [ ] `0002_core_pipeline.sql` does not recreate `settings`; `pnpm db:migrate:local` and `pnpm run deploy` apply it, and re-running is a no-op.
- [ ] Through Access, the bootstrap admin creates a project, destination, and source; a request without Access gets `401`, a non-listed email gets `403`.
- [ ] A `curl` with a valid HMAC to `/in/:id` returns `202`, and a real backend receives the request with a valid Standard Webhooks signature and `X-Webhook-Event-ID`.
- [ ] With the backend stopped, a webhook still returns `202`, and `GET /events/:id` shows `failed_final` with `error_kind=network`.
- [ ] No secret, signature, or token appears in Workers Logs.
