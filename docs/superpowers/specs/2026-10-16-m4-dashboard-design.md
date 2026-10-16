# M4 — Dashboard: Design Spec

> Milestone M4 of the [roadmap](2026-10-14-hookflare-roadmap.md). M3 finished the admin API: RBAC, audit logs, event search, failures, replay, test delivery, and secret rotation. Operators can still reach all of it only through `curl`. M4 adds the dashboard (`apps/dashboard`), served by the same Worker as static assets. It also adds the backend pieces the dashboard needs and M3 deferred: `stats_hourly` with its rollup job, `GET /overview`, and `GET/PATCH /settings` for the global retry defaults.

## 1. Goal and exit criteria

**Goal:** an operator can see the health of every project at a glance, find any event or failure, understand its delivery history, and act on it (replay, pause, test, rotate, configure) from the browser. The UI never shows an action the user's role cannot perform.

**Exit criteria (roadmap, `DESIGN.md` §11):**
1. The DLQ is visible on the dashboard.
2. Projects, sources, and destinations can be created and configured entirely from the UI.

## 2. Scope

**In scope**
- `apps/dashboard`: React + Vite + Tailwind + TanStack Router/Query + shadcn/ui, built to static files and served through Workers Static Assets from the gateway Worker.
- Pages: Overview · Projects · Endpoints · Events · Event Detail · Failures · Audit · Settings (Retry defaults, Users).
- A permission-aware JSON viewer for payloads, and a delivery timeline.
- `stats_hourly` + rollup job (every 5 minutes) with a bounded backfill.
- `GET /overview`, `GET /destinations/stats`, `GET /settings`, `PATCH /settings`.
- Retry defaults read from the `settings` table instead of the `DEFAULT_POLICY` constant.
- Additive changes to `GET /events` (§7.4).
- Component tests, and one Playwright smoke test covering both exit criteria.

**Out of scope (and the milestone that adds it)**
- Archives page, Settings › Storage (M5).
- Alerts page, Settings › Alerts, alert banners on the Overview (M5).
- `DestinationLimiter` and editing `max_in_flight` / `rate_limit_per_s` (M5).
- Dark mode, i18n, mobile layouts below 1024 px (backlog). The dashboard targets desktop browsers.
- Live updates over WebSockets/SSE. Polling is enough for an internal tool (§9.2).
- Typed create/edit forms for destinations and sources (backlog). `DestinationFormDialog` and `SourceFormDialog` each switch between a create and a patch schema at runtime and pass the resolver through an `as never` cast; removing it means splitting each into separate create and edit forms. Server-side validation is unaffected.

## 3. Decisions taken in this spec

| # | Topic | Decision | Why |
|---|---|---|---|
| M4-1 | Serving | `apps/dashboard` builds to `apps/dashboard/dist`. The gateway's `wrangler.jsonc` points `assets.directory` at it, with `not_found_handling: "single-page-application"` and `run_worker_first: ["/api/*", "/in/*", "/healthz"]`. | Assets are served at the edge without Worker CPU. Access runs before the Worker, so assets and the API are protected the same way. The gateway build, `pnpm dev`, and the gateway tests stay unchanged. |
| M4-2 | Local development | `vite dev` (HMR) proxies `/api` to `wrangler dev` on `127.0.0.1:8787`, which uses `ACCESS_DEV_EMAIL`. | No second build path for the Worker (the `@cloudflare/vite-plugin` alternative would build the gateway through the dashboard's Vite config). |
| M4-3 | UI components | shadcn/ui (Radix primitives + Tailwind), copied into `src/components/ui/`. | Accessible dialogs, menus, and focus handling, with no large runtime UI library. |
| M4-4 | Validation | Forms use react-hook-form + `zodResolver` with the request schemas from `@hookflare/shared`. Server `400 invalid_request` `issues` are mapped back onto fields. | Client and server can never disagree on what a valid source or destination is. |
| M4-5 | Rollup | Every run recomputes the **last 3 hours** (delete + `INSERT … SELECT` per hour in one `db.batch`). It never increments counters. | Idempotent: a missed or duplicated run never skews the numbers, and 3 hours tolerates several missed crons. |
| M4-6 | Rollup backfill | A cursor `rollup.backfill_before` in `settings` moves back up to 6 hours per run until it passes the oldest event, then the backfill stops. | Events stored by M1–M3 have no stats. The bound keeps each cron run short. |
| M4-7 | Trend granularity | `GET /overview` always returns an hourly series. The dashboard groups it into days for 7d/30d in the **browser's time zone**. | The server never deals with time zones. 30 days is 720 points at most. |
| M4-8 | Retry defaults | Stored under the `settings` key `retry_defaults`. When no row exists, `DEFAULT_POLICY` applies. The consumer and test delivery read the defaults through a per-isolate cache with a 30 s TTL. | One extra D1 read per isolate per 30 s instead of one per delivery. A change reaches every delivery within 30 s. |
| M4-9 | Settings permission | New permission `settings.manage` (admin only) for `PATCH /settings`. `GET /settings` needs `events.read`. | The roadmap gives Settings to admins. Every role reads the defaults, because the destination form shows them as placeholders. |
| M4-10 | Payload loading | The dashboard requests `GET /events/:id/payload` only when the user clicks "Show payload". | Each request writes `event.payload_viewed` (M3-12). Loading it automatically would audit page views nobody intended. |
| M4-11 | Filters | Every list filter lives in the URL search params, validated with zod through TanStack Router's `validateSearch`. | Every filtered view is a shareable link. |
| M4-12 | Permissions in the UI | `GET /me` drives a `<Can permission>` component that **hides** actions and menu items the role lacks. A `403` from any call shows a toast and refetches `/me`. | The UI only hides; the server still decides. The `403` path covers a role changed mid-session. |
| M4-13 | E2E data | The Playwright smoke test seeds its `dead` delivery directly into local D1 instead of driving it through the pipeline. | The SSRF guard blocks every local backend (HTTPS only, no loopback). The smoke test proves the UI; M2 already tests the pipeline. |

### 3.1 Deviations from the roadmap and earlier milestones

| Source | Change | Reason |
|---|---|---|
| Roadmap §7.3 Rollup "recomputes the current and previous hour" | Recomputes the last 3 hours, plus a bounded backfill | M4-5, M4-6 |
| Roadmap §8 "Settings, user management: Admin" | Split into `settings.manage` and the existing `users.manage`, both admin only | M4-9 |
| Roadmap §8 Settings page "Retry defaults, Storage, Alerts, Users" | Storage and Alerts tabs move to M5 | §2 |
| M3 §8.2 `latest_delivery` fields | Adds `destination_id`, `last_http_status`, `next_attempt_at` | The Events table shows Destination, HTTP Status, and Next Retry (`DESIGN.md` §4.4) |
| M3 §8.2 `GET /events` filters | Adds `http_status` | `DESIGN.md` §4.4 "filtering by … HTTP code" |
| Roadmap §8 REST endpoints | Adds `GET /destinations/stats` | The Endpoints page needs Success Rate, Last Delivery, and Last Error per destination (`DESIGN.md` §4.3) |
| M2 `DEFAULT_POLICY` constant | Becomes the fallback; the effective defaults come from `settings` | M4-8 |

## 4. Layout

```text
apps/gateway/
├── migrations/0006_dashboard.sql        # generated
├── wrangler.jsonc                       # + assets, + "*/5 * * * *" cron
└── src/
    ├── core/
    │   ├── policy.ts                    # resolvePolicy(dest, defaults)
    │   ├── settings.ts                  # retry defaults: load, validate, 30 s cache
    │   ├── rbac.ts                      # + settings.manage
    │   └── db/
    │       ├── schema.ts                # + stats_hourly, + 2 indexes
    │       ├── stats.ts                 # rollup statements, overview and destination stats queries
    │       └── events.ts                # + http_status filter, wider latest_delivery
    ├── jobs/
    │   ├── rollup.ts
    │   └── scheduled.ts                 # dispatches reconcile and rollup by cron
    └── admin/routes/
        ├── overview.ts  settings.ts     # new
        └── destinations.ts  events.ts   # + /destinations/stats, + http_status

apps/dashboard/
├── index.html  vite.config.ts  components.json  playwright.config.ts
├── public/_headers                      # CSP and security headers
├── e2e/smoke.spec.ts
└── src/
    ├── main.tsx                         # QueryClient + RouterProvider
    ├── routes/                          # TanStack Router, file-based (@tanstack/router-plugin)
    ├── lib/
    │   ├── api.ts                       # fetch wrapper, ApiError, session-expired detection
    │   ├── permissions.tsx              # useMe(), <Can>
    │   ├── time.ts                      # formatting, day grouping in local time zone
    │   └── queries/                     # query key factories and hooks per resource
    └── components/
        ├── ui/                          # shadcn/ui
        ├── JsonViewer.tsx  DeliveryTimeline.tsx  StatusBadge.tsx
        ├── CursorTable.tsx  ReplayDialog.tsx  SecretRevealDialog.tsx
        ├── RotateSecretDialog.tsx  TestDeliveryDialog.tsx  ConfirmDialog.tsx
        └── charts/TrendChart.tsx

packages/shared/src/                     # + overview, destination stats, settings schemas and DTOs
scripts/ensure-dashboard-dist.mjs        # creates dist/index.html placeholder when missing
```

Module rules are unchanged. `jobs/rollup.ts` imports from `core/` only. The dashboard imports from `@hookflare/shared` only, never from `apps/gateway`.

## 5. Schema — `0006_dashboard.sql` (generated)

**New table** (non-`STRICT`, timestamps in epoch ms):

| Table | Columns | Keys |
|---|---|---|
| `stats_hourly` | `hour` (start of the UTC hour), `project_id`, `source_id`, `destination_id`, `received`, `delivered`, `failed_final`, `dead`, `attempts` (all counters `INTEGER NOT NULL DEFAULT 0`) | PK `(hour, project_id, source_id, destination_id)`; index `(project_id, hour)` |

There are no foreign keys, so stats survive archival (M5) of the rows they count.

**New indexes:** `webhook_events(received_at)` and `delivery_attempts(started_at)`, for the rollup's hour-range scans. `deliveries(status, completed_at)` already exists (M3).

## 6. Rollup job

`jobs/rollup.ts`, cron `*/5 * * * *` (added to `triggers.crons`; `runScheduled` dispatches on `controller.cron`, and both crons fire as separate invocations at minutes divisible by 5).

### 6.1 Counting rules for hour `H`

| Counter | Rows counted | Dimensions |
|---|---|---|
| `received` | `webhook_events` with `received_at ∈ H` | the event's project and source, and the destination of its `initial` delivery |
| `delivered`, `failed_final`, `dead` | `deliveries` with that terminal `status` and `completed_at ∈ H`, any `kind` | the delivery's project and destination, and its event's source |
| `attempts` | `delivery_attempts` with `started_at ∈ H` | through the attempt's delivery and event |

Replay deliveries count, so a replay that succeeds raises `delivered`. Test deliveries live in `test_deliveries` and never count.

### 6.2 Run

1. For each of the last 3 hours (`H₀` = the current hour, `H₋₁`, `H₋₂`): one `db.batch` of `DELETE FROM stats_hourly WHERE hour = H` plus one `INSERT … SELECT … GROUP BY` per counter group, merged with `ON CONFLICT (hour, project_id, source_id, destination_id) DO UPDATE` adding into the right column.
2. **Backfill:** read `rollup.backfill_before` from `settings` (missing → `H₋₂`). If it is not `"done"`, recompute up to 6 more hours ending before it, then store the new cursor. When the cursor passes the oldest `webhook_events.received_at`, store `"done"`.
3. Log `rollup.run` with the hours recomputed and the row counts.

A failure in one hour's batch is logged; the remaining hours still run. The next run repairs it (M4-5).

## 7. Admin API additions

All paths are under `/api/admin/v1`. Errors keep the M1/M3 shape. `/destinations/stats` is registered before `/destinations/:id`.

### 7.1 `GET /overview` — `events.read`

| Query | Notes |
|---|---|
| `project_id` | Optional equality filter |
| `range` | `24h` (default), `7d`, `30d`; the window ends at the end of the current hour |

Response:
- `totals`: sums of `received`, `delivered`, `failed_final`, `dead`, `attempts` over the window, plus `success_rate = delivered / (delivered + failed_final + dead)`, or `null` when the denominator is 0.
- `live`: current counts of `pending`, `queued`, `in_flight`, `retrying`, `paused` deliveries (not limited by `range`), read from `deliveries`.
- `trend`: one point per hour in the window, `{hour, received, delivered, failed}` where `failed = failed_final + dead`. Hours with no row are returned as zeros.
- `failing_destinations`: the top 5 destinations by `failed_final + dead` in the window, each with `destination_id`, `name`, `failed`, `delivered`. Destinations with 0 failures are omitted.
- `generated_at`: the `deps.now()` value used for the window, so the UI can say how fresh the data is (at most ~5 minutes behind).

### 7.2 `GET /destinations/stats` — `events.read`

Query: `project_id` (optional), `range` (as above, default `24h`). One item per destination in scope: `destination_id`, `delivered`, `failed`, `success_rate` (from `stats_hourly`, `null` when nothing completed), and `last_delivery_at`, `last_http_status`, `last_error` from the newest terminal delivery of that destination, all `null` when none exists. "Newest" means newest by `created_at`, through the `deliveries(destination_id, created_at)` index, not newest by `completed_at`: an older delivery that retried for hours and then died is not shown if a newer one finished first. This is accepted for M4 because no index covers `(destination_id, completed_at)`; the Failures page is where every recent failure is listed.

### 7.3 `GET /settings` and `PATCH /settings`

- `GET /settings` (`events.read`) → `{retry_defaults: {timeout_ms, max_attempts, backoff_base_s, backoff_max_s}, updated_at}`. When no row exists, `retry_defaults` is `DEFAULT_POLICY` and `updated_at` is `null`.
- `PATCH /settings` (`settings.manage`): `{retry_defaults: {...}, reason?}`. All four fields are required, with the same bounds as the destination policy fields (`backoff_max_s` ≤ 43200, `backoff_base_s` ≤ `backoff_max_s`). One `db.batch`: upsert `settings` + audit `settings.updated` with `{before, after}`. The upsert only lands if `updated_at` still matches the value read for `before`, and the audit row is written only if it did; a concurrent update answers `409 conflict` with nothing written, so `before` is never stale. A stored row that fails validation is served as the defaults and logs `settings.retry_defaults_invalid`. Response: the `GET` shape.
- **Effective policy:** `resolvePolicy(dest, defaults)`. A field set on the destination always wins. `core/settings.ts` caches the defaults per isolate for 30 s, like the source cache. A D1 error while loading the defaults is an infra error (`msg.retry`, no attempt counted).

### 7.4 `GET /events` changes (additive)

- `latest_delivery` gains `destination_id`, `last_http_status`, `next_attempt_at`.
- New filter `http_status` (integer 100–599): `EXISTS (SELECT 1 FROM deliveries d WHERE d.event_id = e.id AND d.last_http_status = :http_status)`. It combines with the other delivery filters inside the same `EXISTS`.

### 7.5 RBAC

`settings.manage` is added to `PERMISSIONS` in `@hookflare/shared` and to the admin role in `core/rbac.ts`. Endpoint map additions:

| Method | Path | Permission |
|---|---|---|
| GET | `/overview`, `/destinations/stats`, `/settings` | `events.read` |
| PATCH | `/settings` | `settings.manage` |

## 8. Serving the dashboard

- **`wrangler.jsonc`:** `assets: { directory: "../dashboard/dist", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api/*", "/in/*", "/healthz"] }`. Because of `run_worker_first`, an unknown `/api/...` path still reaches Hono and gets the JSON `404`, not `index.html`.
- **Access:** the Access application covers the whole hostname, with a bypass policy for `/in/*` and `/healthz` (roadmap §8). Static assets therefore require an Access session, and the deploy runbook (M6) documents both policies.
- **Headers (`public/_headers`):** for `/*`: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`. `'unsafe-inline'` for styles is required by Radix. Hashed files under `/assets/*` get `Cache-Control: public, max-age=31536000, immutable`; `index.html` gets `no-cache`.
- **Missing `dist/`:** wrangler fails when `assets.directory` does not exist. `scripts/ensure-dashboard-dist.mjs` creates `apps/dashboard/dist/index.html` (a placeholder) when it is missing. It runs before root `dev` and the gateway `test` script, so neither depends on a real dashboard build.
- **Scripts:** root `dev:dashboard` (Vite on `5173`, proxying `/api` to `127.0.0.1:8787`), `build` (dashboard build), and `deploy` = build dashboard → `db:migrate:remote` → `wrangler deploy`.

## 9. Dashboard architecture

### 9.1 API client and session handling
- `lib/api.ts` calls same-origin URLs with `credentials: "same-origin"`. A JSON error body becomes an `ApiError {status, code, issues?, required?}`.
- **Expired Access session:** Access answers an API call with a redirect to its login domain. `fetch` either fails (CORS on the cross-origin redirect) or returns HTML. Both cases become `session_expired`, which shows a blocking banner "Session expired — Reload". Reload does a full page load, so Access shows its login page.
- **`403` on `/me`:** the "No access" page, showing the signed-in email and asking an admin to add it.

### 9.2 Queries
- TanStack Query, with a key factory per resource in `lib/queries/`. Lists use `useInfiniteQuery` over `next_cursor`, with a "Load more" button (no page numbers, cursors only).
- Mutations invalidate the keys they affect: replay invalidates the event, its deliveries, and failures; pause/resume invalidates the destination and its stats.
- The Overview refetches every 15 s while the tab is visible (`refetchInterval` + `refetchIntervalInBackground: false`). Event Detail uses the same interval, but only while at least one of its deliveries is non-terminal; once every delivery is terminal nothing on the page can change, so polling stops. Other pages refresh on demand, through a refresh button and on window focus.

### 9.3 Permissions
- `useMe()` loads `/me` once (`staleTime: Infinity`) and is refetched after any `403`.
- `<Can permission="…">` renders its children only when the permission is in `me.permissions`. Navigation hides Audit (`audit.read`) and Settings › Users (`users.manage`). Settings › Retry defaults is read-only without `settings.manage`.

### 9.4 Formatting
- Times are shown in the browser's time zone as relative text ("3 min ago"), with the absolute local time and the ISO UTC value in a tooltip.
- IDs use a monospace font and a copy button.
- Status badges have one color per delivery status, used in every table and in the timeline.

## 10. Pages

The rightmost column lists the minimum permission for each action. Without it, the action is hidden.

| Page | Content | Actions |
|---|---|---|
| **Overview** | Project and range (24h/7d/30d) filters. Stat tiles: Received, Delivered, Success rate, Failed Final, Dead (`totals`); Pending, Retrying, Paused (`live`). Trend chart (received / delivered / failed). Failing destinations table, each row linking to Failures filtered by that destination. Recent events (`GET /events?limit=10`). | — |
| **Projects** | List with status. Detail page: project fields plus the Overview content filtered to the project (`DESIGN.md` §4.2 "statistics per project"). | Create, Edit, Disable — `config.write`. No Delete. |
| **Endpoints** | Tabs **Sources** \| **Destinations**, filtered by project. Destinations: name, URL, status, policy (an empty field shows "default: N" from `/settings`), and Success rate, Last delivery, Last error from `/destinations/stats`. Sources: name, `ingress_url` with a copy button, auth type, target destination, status. Detail pages show the full configuration, secret fingerprints, and an active grace window ("previous secret valid until …"). | Create, Edit, Disable, Rotate secret — `config.write`. Pause, Resume, Test — `destinations.operate`. |
| **Events** | Columns: Received At, Event ID, Source, Destination, Status, HTTP, Attempts, Next Retry. Filters: project, source, destination, status (multi), HTTP status, time range. Search box: an `evt_…` value opens Event Detail directly; a provider event ID requires a selected source (the API rule). | — |
| **Event Detail** | Metadata, provider event ID, content type, size, SHA-256, redacted headers. One **DeliveryTimeline** per delivery, newest first, `replay` deliveries with a badge and their `created_by`. Payload panel. | Copy Event ID. Show payload — `payload.read`. Replay — `deliveries.replay`. |
| **Failures** | Tabs **Failed Final** \| **Dead Letter** (the DLQ view). Filters: project, destination, time range, unresolved (default on). Columns: completed at, event, destination, attempts, HTTP / `last_error`, latest replay and its status. Row checkboxes, up to 100. | Replay selected, Replay one — `deliveries.replay`. |
| **Audit** | Filters: actor, resource type, resource ID, action, time range. Clicking a row opens its `diff_json` in the JsonViewer. | — (page needs `audit.read`) |
| **Settings** | Tabs **Retry defaults** (form) \| **Users** (list, add, change role, disable/enable). | Save defaults — `settings.manage`. Users — `users.manage`. |

## 11. Shared components and interaction rules

- **DeliveryTimeline:** built from one delivery and its attempts: `Received` (event `received_at`) → one row per attempt (`Attempt #n`, HTTP status or `error_kind`, duration, error message, expandable response snippet) → `Retrying — next attempt at …` while `retrying` → the terminal row (`Delivered` / `Failed final` / `Dead`, at `completed_at`). `paused` and `queued` show as a pending row.
- **JsonViewer:** a collapsible tree when the content type is JSON and the body parses, otherwise plain text with a Download button. It renders text nodes only, never `dangerouslySetInnerHTML`. Bodies over 256 KB start collapsed at depth 1. The same component shows audit diffs.
- **Payload panel:** empty until "Show payload" is clicked (M4-10). A `404 payload_missing` shows "Payload no longer available".
- **ReplayDialog:** single and bulk. `reason` is required (1–500 characters). The result lists replayed and skipped items with their reason codes. When `enqueued: false`, it says the reconciler enqueues the delivery within a minute.
- **SecretRevealDialog:** after a create or rotate that returns a secret. It shows the secret with a copy button and closes only after the user ticks "I have stored this secret". The secret is kept in component state only and dropped on close.
- **RotateSecretDialog:** `grace_hours` (default 24, 0–168) and an optional `reason`; for sources, an optional supplied secret. `grace_hours = 0` shows a red "revokes the current secret immediately" warning.
- **TestDeliveryDialog:** an optional JSON payload (validated as JSON, ≤ 64 KB), then the result (HTTP status, duration, error, snippet). The destination detail page lists `GET /destinations/:id/tests` below.
- **ConfirmDialog:** for Disable, Pause, and role changes, with an optional `reason` sent to the API.

## 12. Testing

### 12.1 Gateway (Vitest + `@cloudflare/vitest-plugin`)
- **Rollup:**
  - Counts per dimension; `received` uses the initial delivery's destination.
  - Replays count; test deliveries do not.
  - Two runs in a row give identical rows.
  - A delivery completed in `H₋₁` is counted.
  - Backfill moves back 6 hours per run and stores `"done"` after the oldest event.
  - A failing batch for one hour does not stop the others.
- **`/overview`:** `success_rate` `null` on zero; `live` ignores `range`; `trend` has one point per hour including empty hours; the `project_id` filter; top-5 ordering of `failing_destinations`.
- **`/destinations/stats`:** the newest terminal delivery wins; destinations without deliveries return `null`s.
- **Settings:**
  - Bounds validation.
  - Audit written in the same batch; a failing batch writes neither (fault injection).
  - The consumer uses new defaults after the cache TTL (advancing `deps.now`).
  - A destination's own policy field wins over the defaults.
- **Events:** the `http_status` filter alone and combined with `status`; the new `latest_delivery` fields.
- **RBAC:** the M3 matrix and route-coverage tests include every new route and `settings.manage`.

### 12.2 Dashboard (Vitest + Testing Library + MSW)
- **Permissions:**
  - For each role, actions render or are hidden exactly as §10 says.
  - Navigation hides Audit and Users.
  - A `403` refetches `/me`.
- **Forms:**
  - Shared schemas report errors on the right fields.
  - Server `issues` map onto fields.
  - Policy placeholders come from `/settings`.
- **Payload:** no `/payload` request before "Show payload"; JSON renders as a tree, non-JSON as text; `payload_missing` message.
- **Session:** an HTML response or a failed redirect shows the session-expired banner; `403` on `/me` shows No access.
- **Dialogs:**
  - Replay requires a reason and shows skipped items and `enqueued: false`.
  - The secret dialog cannot close before the checkbox is ticked.
  - `grace_hours = 0` shows the warning.
- **DeliveryTimeline:** order and labels for a retry → dead fixture and a replay → delivered fixture.
- **Trend grouping:** hourly points grouped into days in a fixed test time zone (`TZ` set in the test config).
- **URL filters:** a filtered Failures URL restores the same filters on load.

### 12.3 E2E smoke (Playwright, in CI)
The CI job builds the dashboard, applies local migrations, and starts `wrangler dev` with `ACCESS_DEV_EMAIL` set to a bootstrap admin. Then:
1. Create a project, a destination, and a source entirely through the UI; assert the source's `ingress_url` is shown and the destination appears in Endpoints.
2. Seed one event and one `dead` delivery for that destination with `wrangler d1 execute --local` (M4-13), open Failures › Dead Letter, and assert the row is visible.

### 12.4 Exit criteria mapping

| Exit criterion | Tests |
|---|---|
| The DLQ is visible on the dashboard | E2E step 2; Dead Letter tab component test |
| Projects, sources, and destinations can be created and configured from the UI | E2E step 1; form tests |

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Rollup queries on a busy hour at the DEC-2 upper tier (~40k events/hour) | A long cron run per hour recomputed | Hour-range indexes (§5); measure in the M6 benchmark; reduce the recompute window to 2 hours if needed |
| `live` counts scan the non-terminal part of `deliveries` | Slow Overview during a large backlog (e.g. a destination paused for days) | The `(status, …)` indexes cover the scan; refetch is limited to the visible Overview tab every 15 s |
| Retry defaults cached for 30 s | A change does not apply instantly | Documented in the Settings form ("applies within 30 seconds") |
| Stats lag behind live data by up to 5 minutes | Totals and live counts can disagree briefly | The Overview shows `generated_at` and labels the totals "updated every 5 minutes" |
| Access session expiry during a mutation | The request fails and the user loses form input | Form state stays in place under the session-expired banner; the user can copy it before reloading |
