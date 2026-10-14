# Hookflare

**A reliable inbound webhook gateway that runs entirely on Cloudflare.**

Hookflare sits between webhook providers (Stripe, GitHub, Shopify, your own services…) and your backends. It verifies each incoming webhook, persists it durably, and acknowledges it, all before your backend is involved. It then delivers the webhook with automatic retries, keeps a full delivery log, and lets you replay anything from a dashboard.

> [!NOTE]
> **Status: M0 (Foundation) done.** Monorepo scaffold, Wrangler config, D1 migrations, and CI are in place. The setup instructions below describe the current M0 setup; Queues and R2 buckets arrive in later milestones when first used.

---

## Why Hookflare?

When your backend goes down, deploys, or gets overloaded, webhook providers retry only for a limited time and then drop events. Hookflare decouples **receiving** a webhook from **processing** it:

- **Never lose a webhook.** An event is acknowledged with `202 Accepted` only after it is stored in D1 (and R2 for large payloads) **and** enqueued. If any of those steps fails, the provider gets a `503` and retries.
- **Survive long outages.** Exponential backoff with jitter keeps retrying for roughly 68 hours by default, so a backend that is down for two days still receives every event.
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
- **Tooling:** pnpm workspaces, Wrangler, Vitest with `@cloudflare/vitest-pool-workers`

## Getting started

> [!NOTE]
> These steps describe the current M0 setup. Exact commands, resource names, and config files may still evolve as later milestones (Queues, R2) land.

### Prerequisites

- A Cloudflare account with **Workers Paid** (recommended for 14-day queue retention)
- A Cloudflare **Zero Trust** organization for Access
- Node.js LTS, [pnpm](https://pnpm.io/), and [Wrangler](https://developers.cloudflare.com/workers/wrangler/)

### 1. Create Cloudflare resources

Each deployment is one isolated environment. For another independent deployment, use a separate copy of `wrangler.jsonc` with its own resource names and IDs.

```bash
wrangler d1 create hookflare
```

(Queues and R2 buckets are created by later milestones when they are first used.)

Copy the resulting `database_id` into `apps/gateway/wrangler.jsonc`.

### 2. Configure secrets

`SECRETS_KEY` is 32 random bytes, base64-encoded. Generate one with:

```bash
openssl rand -base64 32
```

Then store it (and the bootstrap admin list) as Worker secrets:

```bash
wrangler secret put SECRETS_KEY              # key that encrypts stored secrets
wrangler secret put BOOTSTRAP_ADMIN_EMAILS   # comma-separated emails that become Admin on first login
```

Also set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (the Access application audience tag) so the Worker can verify Access JWTs.

### 3. Protect the dashboard with Cloudflare Access

Create an Access application that covers the dashboard (`/`) and the admin API (`/api/admin/*`). Bypass (leave public) `/in/*` and `/healthz`, because webhook providers and uptime monitors must be able to reach them without logging in.

### 4. Migrate and deploy

```bash
pnpm install
wrangler d1 migrations apply hookflare --remote
pnpm run deploy
```

### 5. Receive your first webhook

1. Sign in to the dashboard with a bootstrap admin email.
2. Create a **project**, a **destination** (your backend URL), and a **source** that points to it.
3. Configure your provider to send webhooks to `https://<your-worker-domain>/in/<sourceId>`.
4. Verify the signature in your backend with any [Standard Webhooks library](https://github.com/standard-webhooks/standard-webhooks#reference-implementations).

## Delivery contract for your backend

Each request Hookflare sends to your backend includes:

| Header | Purpose |
|---|---|
| `webhook-id`, `webhook-timestamp`, `webhook-signature` | Standard Webhooks signature, used to verify the request came from Hookflare |
| `X-Webhook-Event-ID` | Stable event ID; **use it as your idempotency key** |
| `X-Webhook-Delivery-ID` | ID of this delivery (a replay gets a new one) |
| `X-Webhook-Attempt` | Attempt number, starting at 1 |

Return any `2xx` to acknowledge. Return `429` (optionally with `Retry-After`) or `5xx` to ask for a retry. Any other `4xx` or `3xx` marks the delivery as failed without retrying. Redirects are never followed.

## Roadmap

| Milestone | Scope | Status |
|---|---|---|
| **M0: Foundation** | Monorepo, Wrangler config, migrations, CI | Done |
| **M1: Core pipeline** | Ingress, D1 ledger, queue, single-shot delivery, signing, SSRF guard | Planned |
| **M2: Reliability** | Retries, dead letter, idempotency, R2 payloads, reconciler, pause/resume | Planned |
| **M3: Admin API & security** | Access + RBAC, audit log, replay, test delivery, secret rotation | Planned |
| **M4: Dashboard** | All dashboard pages, stats rollups | Planned |
| **M5: Operations** | Alerting, R2 archival, per-destination concurrency and rate limits | Planned |
| **M6: Production readiness** | Benchmarks, backup/restore, runbook, uptime monitoring | Planned |

Full details: [`docs/superpowers/specs/2026-10-14-hookflare-roadmap.md`](docs/superpowers/specs/2026-10-14-hookflare-roadmap.md). The original system spec is in [`DESIGN.md`](DESIGN.md).

### Out of scope

Hookflare is deliberately **not** an integration platform. The following are out of scope: payload transformations, multi-destination fan-out, workflow editors, SaaS billing, and real-time WebSocket dashboards.

## Contributing

The project is in its design phase, and feedback on the [roadmap](docs/superpowers/specs/2026-10-14-hookflare-roadmap.md) is very welcome. Please open an issue to discuss a change before you send a pull request.

## License

[MIT](LICENSE)
