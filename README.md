# Hookflare

**A reliable inbound webhook gateway that runs entirely on Cloudflare.**

Hookflare sits between webhook providers (Stripe, GitHub, Shopify, your own services…) and your backends. It verifies each incoming webhook, persists it durably, and acknowledges it, all before your backend is involved. It then delivers the webhook with automatic retries, keeps a full delivery log, and lets you replay anything from a dashboard.

> [!NOTE]
> **Status: M5 (Operations) done.** Webhooks are received, verified, stored in D1 (and R2 for large payloads), queued, and delivered with retries, a reconciler, pause/resume, RBAC admin API, dashboard, alerts, archival, and per-destination limits. M6 (Production readiness) is in progress.

Operations runbook: [`docs/runbook/`](docs/runbook/).

---

## Why Hookflare?

When your backend goes down, deploys, or gets overloaded, webhook providers retry only for a limited time and then drop events. Hookflare decouples **receiving** a webhook from **processing** it:

- **Never lose a webhook.** An event is acknowledged with `202 Accepted` only after it is stored in D1 (and R2 for large payloads) **and** enqueued. If any of those steps fails, the provider gets a `503` and retries.
- **Survive long outages.** Exponential backoff with jitter keeps retrying for roughly 62 hours by default, so a backend that is down for two days still receives every event.
- **See everything.** Every delivery attempt is logged with its HTTP status, latency, and error. You can search events, inspect payloads, and replay one or many from the dashboard.
- **Zero servers to run.** It is built only on Cloudflare managed services: Workers, D1, Queues, R2, Durable Objects, and Access.

## Features

| Area | What you get |
|---|---|
| **Ingress** | One public URL per source; HMAC / token / no-auth verification on the raw body; deduplication by provider event ID; body size limits and rate limits |
| **Delivery** | At-least-once delivery; [Standard Webhooks](https://www.standardwebhooks.com/) signing toward your backend; per-destination timeout, retry budget, backoff, concurrency, and rate limit |
| **Retry & DLQ** | Retries on 408/429/5xx, network errors, and timeouts (honoring `Retry-After`); other 3xx/4xx responses fail immediately; events that exhaust their retries become dead-lettered |
| **Recovery** | A cron reconciler re-enqueues stuck, lost, or never-enqueued deliveries; pausing an endpoint holds its deliveries and resuming it releases them |
| **Dashboard** | Overview stats and trends, event search, delivery timelines, a failures / dead-letter view, single and bulk replay, endpoint management |
| **Security** | Cloudflare Access login, Admin / Operator / Viewer roles, audit log for every change, encrypted secrets, SSRF protection, HTTPS-only destinations, credential headers stripped |
| **Operations** | Alerts sent to Slack, Discord, or any webhook; daily archival of old data to R2; configurable retention |

## How it works

```text
Provider ──POST /in/:sourceId──▶ Ingress ──▶ D1 ledger (+ R2 for large payloads)
                                   │
                                   ▼
                           Cloudflare Queue ──▶ Delivery consumer ──▶ Your backend
                                                     │                  2xx  ✔ delivered
                                                     │                  5xx  ↻ retry with backoff
                                                     ▼                  4xx  ✖ failed
                                             D1 attempt log ──▶ dead letter after retry budget

Dashboard ──(Cloudflare Access)──▶ Admin API ──▶ D1 / R2
Cron ──▶ reconcile · alerts · stats rollup · archive & retention
```

D1 is the source of truth. The queue is only a transport, so the reconciler can always rebuild work from the database. Your backend must be idempotent: deduplicate by the `X-Webhook-Event-ID` (or `webhook-id`) header, because at-least-once delivery means the same event can occasionally arrive more than once.

## Tech stack

- **Runtime:** Cloudflare Workers, [Hono](https://hono.dev/), TypeScript
- **Storage:** Cloudflare D1 (ledger), R2 (large payloads and archives), Queues (delivery), Durable Objects (per-destination limiter)
- **Auth:** Cloudflare Access + server-side RBAC
- **Dashboard:** React, Vite, Tailwind CSS, TanStack Router / Query
- **Tooling:** pnpm workspaces, Wrangler, Vitest with `@cloudflare/vitest-plugin`

## Getting started

> [!NOTE]
> These steps describe the current M2 setup. Exact commands, resource names, and config files may still evolve as later milestones (Durable Objects) land.

### Prerequisites

- A Cloudflare account with **Workers Paid** (recommended for 14-day queue retention)
- A Cloudflare **Zero Trust** organization for Access
- Node.js LTS, [pnpm](https://pnpm.io/), and [Wrangler](https://developers.cloudflare.com/workers/wrangler/)

### 1. Create Cloudflare resources

Each deployment is one isolated environment. For another independent deployment, use a separate copy of `wrangler.jsonc` with its own resource names and IDs.

```bash
pnpm exec wrangler d1 create hookflare
pnpm exec wrangler queues create hookflare-deliveries
pnpm exec wrangler queues create hookflare-deliveries-dlq
pnpm exec wrangler r2 bucket create hookflare-payloads
```

The ingress rate limiter (`INGRESS_LIMITER`, 100 requests per 10 s per source) is declared in `wrangler.jsonc` and needs no setup. The cron trigger (`* * * * *`, reconciler) is likewise declared in `wrangler.jsonc` and deployed with the Worker.

Replace the committed `database_id` in `apps/gateway/wrangler.jsonc` (the maintainers' production database) with the ID from that command.

Run Wrangler from the repository root with `pnpm exec wrangler … --config apps/gateway/wrangler.jsonc`, or `cd apps/gateway` first.

### 2. Configure secrets

`SECRETS_KEY` is 32 random bytes, base64-encoded. Generate one with:

```bash
openssl rand -base64 32
```

Then store it as a Worker secret (run from the repository root):

```bash
pnpm exec wrangler secret put SECRETS_KEY --config apps/gateway/wrangler.jsonc
```

For local development, copy `apps/gateway/.dev.vars.example` to `apps/gateway/.dev.vars` and fill in a key.

### 3. Protect the dashboard with Cloudflare Access

Create an Access application that covers the dashboard (`/`) and the admin API (`/api/admin/*`). Bypass (leave public) `/in/*` and `/healthz`, because webhook providers and uptime monitors must be able to reach them without logging in.

Then set the Access values in `apps/gateway/wrangler.jsonc` → `vars`: `ACCESS_TEAM_DOMAIN` (`https://<team>.cloudflareaccess.com`), `ACCESS_AUD` (the application's AUD tag), and `BOOTSTRAP_ADMIN_EMAILS` (comma-separated). The admin API fails closed (`500`) until both Access values are set. For local development, set `ACCESS_DEV_EMAIL` in `.dev.vars`; it is honored only on `localhost`. If the ingress hostname differs from the admin hostname, set `PUBLIC_BASE_URL` (e.g. `https://hooks.example.com`) so `ingress_url` in admin responses points at it.

### 4. Migrate and deploy

```bash
pnpm install
pnpm run deploy   # applies remote D1 migrations, then deploys the Worker
curl https://<your-worker-domain>/healthz   # {"status":"ok","version":"..."}
```

### 5. Receive your first webhook

```bash
API=http://localhost:8787/api/admin/v1
PROJECT=$(curl -s -X POST $API/projects -H 'content-type: application/json' \
  -d '{"name":"Shop","slug":"shop"}' | jq -r .id)
curl -s -X POST $API/destinations -H 'content-type: application/json' \
  -d "{\"project_id\":\"$PROJECT\",\"name\":\"Backend\",\"url\":\"https://backend.example.com/hooks\"}"
# → save signing_secret: it is shown only once
DEST=<destination id from the response>
curl -s -X POST $API/sources -H 'content-type: application/json' \
  -d "{\"project_id\":\"$PROJECT\",\"destination_id\":\"$DEST\",\"name\":\"Provider\",\"auth_type\":\"hmac\",\"auth_config\":{\"header\":\"x-signature\",\"algorithm\":\"sha256\",\"encoding\":\"hex\"}}"
# → save secret and ingress_url: the secret is shown only once
SOURCE_SECRET=<secret from the response>
INGRESS_URL=<ingress_url from the response>
BODY='{"id":"evt_1","type":"order.paid"}'
SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SOURCE_SECRET" | awk '{print $2}')
curl -i -X POST "$INGRESS_URL" -H 'content-type: application/json' -H "x-signature: $SIG" -d "$BODY"
# → 202 {"event_id":"evt_..."}; then GET $API/events/<event_id> shows the delivery and its attempt
```

On a deployed Worker, replace the host and drop nothing else — Access adds the JWT for browser sessions; for `curl`, use `cloudflared access curl`.

Verify the signature in your backend with any [Standard Webhooks library](https://github.com/standard-webhooks/standard-webhooks#reference-implementations).

Source changes made with `PATCH` can take up to 30 seconds to reach ingress.

## Dashboard

For local development, run `pnpm dev` with `ACCESS_DEV_EMAIL` set in `apps/gateway/.dev.vars`, plus `pnpm dev:dashboard` (Vite on port 5173, proxying `/api` to the Worker).

Production serves the dashboard from the same Worker behind Cloudflare Access. The Access application must cover `/` and `/api/admin/*`, and must not cover `/in/*`.

## Delivery contract for your backend

Each request Hookflare sends to your backend includes:

| Header | Purpose |
|---|---|
| `webhook-id`, `webhook-timestamp`, `webhook-signature` | Standard Webhooks signature, used to verify the request came from Hookflare |
| `X-Webhook-Event-ID` | Stable event ID; **use it as your idempotency key** |
| `X-Webhook-Delivery-ID` | ID of this delivery (a replay gets a new one) |
| `X-Webhook-Attempt` | Attempt number, starting at 1 |

Return any `2xx` to acknowledge. Return `429` (optionally with `Retry-After`) or `5xx` to ask for a retry. Any other `4xx` or `3xx` marks the delivery as failed without retrying. Redirects are never followed.

Retries on `408`/`429`/`5xx`, timeouts, and network errors use exponential backoff (30 s → 6 h by default, ±20% jitter, `Retry-After` honored on `429`), up to 20 attempts (~62 h window) by default. Per-destination `max_attempts`, `backoff_base_s`, and `backoff_max_s` override the defaults. Every retry carries the same `webhook-id`: deduplicate on it, because delivery is at-least-once. `3xx` and other `4xx` responses are final and never retried.

Pausing a destination (`POST /api/admin/v1/destinations/:id/pause`) holds its deliveries with status `paused` without consuming attempts; resuming it (`POST /api/admin/v1/destinations/:id/resume`) releases them for delivery.

## Roadmap

| Milestone | Scope | Status |
|---|---|---|
| **M0: Foundation** | Monorepo, Wrangler config, migrations, CI | Done |
| **M1: Core pipeline** | Ingress, D1 ledger, queue, single-shot delivery, signing, SSRF guard | Done |
| **M2: Reliability** | Retries, dead letter, idempotency, R2 payloads, reconciler, pause/resume | Done |
| **M3: Admin API & security** | Access + RBAC, audit log, replay, test delivery, secret rotation | Planned |
| **M4: Dashboard** | All dashboard pages, stats rollups | Planned |
| **M5: Operations** | Alerting, R2 archival, per-destination concurrency and rate limits | Planned |
| **M6: Production readiness** | Benchmarks, backup/restore, runbook, uptime monitoring | In progress (M6a) |

Full details: [`docs/superpowers/specs/2026-10-14-hookflare-roadmap.md`](docs/superpowers/specs/2026-10-14-hookflare-roadmap.md). The original system spec is in [`DESIGN.md`](DESIGN.md).

### Out of scope

Hookflare is deliberately **not** an integration platform. The following are out of scope: payload transformations, multi-destination fan-out, workflow editors, SaaS billing, and real-time WebSocket dashboards.

## Contributing

The project is in development (M5 done, M6 in progress), and feedback on the [roadmap](docs/superpowers/specs/2026-10-14-hookflare-roadmap.md) is very welcome. Please open an issue to discuss a change before you send a pull request.

## License

[MIT](LICENSE)
