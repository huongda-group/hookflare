# Hookflare

**A reliable inbound webhook gateway that runs entirely on Cloudflare.**

Hookflare sits between webhook providers (Stripe, GitHub, Shopify, your own services…) and your backends. It authenticates incoming webhooks according to source configuration, persists them, and delivers them asynchronously. The dashboard lets operators inspect attempts and replay eligible events.

[Feature documentation](docs/README.md) · [Operations runbook](docs/runbook.md) · [Release index](CHANGELOG.md)

---

## Why Hookflare?

When your backend goes down, deploys, or gets overloaded, webhook providers retry only for a limited time and then drop events. Hookflare decouples **receiving** a webhook from **processing** it:

- **Decouple intake from delivery.** Accepted events are stored before delivery; the [wire contract](docs/contract.md) explains enqueue failures and paused destinations.
- **Recover from outages.** Retryable failures use [configurable backoff and attempt limits](docs/delivery.md). Operators can investigate and replay eligible events after fixing the backend.
- **Inspect delivery history.** Search events, inspect attempt outcomes, and reveal stored payloads with the appropriate permissions.
- **Zero servers to run.** It is built only on Cloudflare managed services: Workers, D1, Queues, R2, Durable Objects, and Workflows.

## Features

| Area | What you get |
|---|---|
| [Ingress](docs/sources.md) | Source authentication, provider event deduplication, and admission controls |
| [Delivery](docs/delivery.md) | Signed, at-least-once delivery with configurable retries and recovery |
| [Dashboard](docs/dashboard.md) | Overview, event investigation, and operator recovery |
| [Security](docs/users.md) | Built-in login, API tokens, role-based permissions, and audit history |
| [Operations](docs/operations.md) | Monitoring, alerts, archival, and backup/restore |

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

Dashboard ──(login session or API token)──▶ Admin API ──▶ D1 / R2
Cron ──▶ reconcile · alerts (1 min) · stats rollup (5 min) · archive (03:00 UTC) · D1 backup (20:00 UTC)
```

D1 is the source of truth. The queue is only a transport, so the reconciler can always rebuild work from the database. Your backend must be idempotent: deduplicate by the `X-Webhook-Event-ID` (or `webhook-id`) header, because at-least-once delivery means the same event can occasionally arrive more than once.

## Tech stack

- **Runtime:** Cloudflare Workers, [Hono](https://hono.dev/), TypeScript
- **Storage:** Cloudflare D1 (ledger, via Drizzle ORM), R2 (large payloads, archives, and backups), Queues (delivery), Durable Objects (per-destination limiter), Workflows (archive and backup)
- **Auth:** Built-in username/password login (server-side sessions in D1) + API tokens + RBAC
- **Dashboard:** React, Vite, Tailwind CSS, TanStack Router / Query
- **Tooling:** pnpm workspaces, Wrangler, Vitest with `@cloudflare/vitest-plugin`, Playwright, Biome

## Installation

Two paths: run everything locally in a few minutes (no Cloudflare account needed), or deploy your own instance to Cloudflare.

### Prerequisites

- Node.js 24 (see [`.nvmrc`](.nvmrc)) and [pnpm](https://pnpm.io/) (`corepack enable` picks the pinned version)
- `git`, `openssl`, `curl`, and `jq` for the examples below
- For a Cloudflare deployment: a Cloudflare account on **Workers Paid** (Queues, Durable Objects, and Workflows; 14-day queue retention)

Wrangler is a dev dependency, so `pnpm exec wrangler` needs no global install.

### Option A: run locally

```bash
git clone https://github.com/huongda-group/hookflare.git
cd hookflare
pnpm install
cp apps/gateway/.dev.vars.example apps/gateway/.dev.vars
# Set SECRETS_KEY to the output of: openssl rand -base64 32
# (the Turnstile test keys already have usable defaults.)
pnpm db:migrate:local   # applies migrations to local D1
pnpm dev                # gateway on http://localhost:8787 (admin API + built dashboard)
```

Open http://localhost:8787, create the first admin on the onboarding page (setup needs no token and closes after the first admin is created), and log in. Local D1, R2, Queues, Durable Objects, and Workflows are all simulated by `wrangler dev`.

For dashboard development with hot reload, also run `pnpm dev:dashboard` and open http://localhost:5173 (Vite proxies `/api` to the Worker).

Check it works:

```bash
curl http://localhost:8787/healthz   # {"status":"ok",...}
pnpm test && pnpm typecheck && pnpm lint
```

### Option B: deploy to Cloudflare

Each deployment is one isolated environment (production and staging are separate Workers with their own resources). The steps below are for production with [`apps/gateway/wrangler.jsonc`](apps/gateway/wrangler.jsonc); for staging use [`wrangler.staging.jsonc`](apps/gateway/wrangler.staging.jsonc), the `-staging` resource names, and `pnpm deploy:staging`. The full procedure, including the sink Worker and the API token used by smoke tests, is in [`docs/runbook.md#setup`](docs/runbook.md#setup).

**1. Log in and create resources**

```bash
pnpm exec wrangler login
pnpm exec wrangler d1 create hookflare
pnpm exec wrangler queues create hookflare-deliveries
pnpm exec wrangler queues create hookflare-deliveries-dlq
pnpm exec wrangler r2 bucket create hookflare-payloads
pnpm exec wrangler r2 bucket create hookflare-backups
```

Put the `database_id` printed by `d1 create` into `apps/gateway/wrangler.jsonc` → `d1_databases[0].database_id` (the committed value is the maintainers' production database). The ingress rate limiter, cron triggers, the `DestinationLimiter` Durable Object, and the `hookflare-archive`/`hookflare-backup` Workflows are declared in the config and created by the deploy.

**2. Set the encryption key**

```bash
openssl rand -base64 32   # keep this value in your password manager
pnpm exec wrangler secret put SECRETS_KEY --config apps/gateway/wrangler.jsonc
```

`SECRETS_KEY` encrypts source secrets, signing secrets, and alert channel configs. A backup cannot replace it: without it a restored database is unreadable.

**3. Create the first admin right after the first deploy**

Open the Worker URL and create the first admin immediately, before the URL is public — setup is first-come, needs no token, and closes once a password-bearing account exists.

**4. (Optional) Turnstile**

Create a Turnstile widget for the Worker's hostname — either in the Cloudflare dashboard (Turnstile → Add widget), or via the Cloudflare API MCP server:

```js
// MCP execute: POST /accounts/{id}/challenges/widgets
// { name: "hookflare", domains: ["<your-worker-hostname>"], mode: "managed" }
```

Then set the site key as a var in `apps/gateway/wrangler.jsonc` → `vars` (`TURNSTILE_SITE_KEY`) and the secret key as a secret:

```bash
pnpm exec wrangler secret put TURNSTILE_SECRET_KEY --config apps/gateway/wrangler.jsonc
```

Turnstile protects the login and onboarding forms. Both values must be set, or neither: with neither set the pages show a "Turnstile is off" notice (and `/healthz` reports it); with only one set, login and setup fail closed. If the ingress hostname differs from the admin hostname, also set `PUBLIC_BASE_URL` in `apps/gateway/wrangler.jsonc` → `vars` (e.g. `https://hooks.example.com`) so `ingress_url` in admin responses points at it.

**5. Deploy**

```bash
pnpm run deploy -- --skip-smoke   # first deploy: no sink or API token yet
curl https://<your-worker-domain>/healthz   # {"status":"ok","version":"<worker version id>"}
```

`pnpm run deploy` runs [`scripts/deploy.mjs`](scripts/deploy.mjs): it records a restore point (D1 Time Travel bookmark and the live Worker version), builds the dashboard, applies remote D1 migrations, deploys the Worker, smoke-tests, and prints the exact rollback commands. Later deploys should run the smoke test; see [`docs/runbook.md#deploy-and-smoke`](docs/runbook.md#deploy-and-smoke). (`pnpm deploy` is a built-in pnpm command, so always use `pnpm run deploy`.)

Open `https://<your-worker-domain>/`, create the first admin on the onboarding page (no token; first-come, so create it before the URL is public), and continue in the dashboard: create a project, a destination, and a source, then add alert channels and review Settings › Storage (retention and backups).

### Receive your first webhook

This uses the local instance from option A. On a deployed Worker, replace the host and authenticate with an API token (create one in Settings › Users).

```bash
API=http://localhost:8787/api/admin/v1
# Log in: the session cookie lands in jar. Cookie requests to non-GET
# endpoints must also send an Origin header.
curl -c jar -b jar -H "origin: http://localhost:8787" -X POST $API/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"<password>"}'
# From here on, -b jar -H "origin: http://localhost:8787" authenticates you.
# (Or skip the jar: -H "authorization: Bearer $HOOKFLARE_API_TOKEN" instead.)
PROJECT=$(curl -s -b jar -H "origin: http://localhost:8787" -X POST $API/projects -H 'content-type: application/json' \
  -d '{"name":"Shop","slug":"shop"}' | jq -r .id)
curl -s -b jar -H "origin: http://localhost:8787" -X POST $API/destinations -H 'content-type: application/json' \
  -d "{\"project_id\":\"$PROJECT\",\"name\":\"Backend\",\"url\":\"https://backend.example.com/hooks\"}"
# → save signing_secret: it is shown only once
DEST=<destination id from the response>
curl -s -b jar -H "origin: http://localhost:8787" -X POST $API/sources -H 'content-type: application/json' \
  -d "{\"project_id\":\"$PROJECT\",\"destination_id\":\"$DEST\",\"name\":\"Provider\",\"auth_type\":\"hmac\",\"auth_config\":{\"header\":\"x-signature\",\"algorithm\":\"sha256\",\"encoding\":\"hex\"}}"
# → save secret and ingress_url: the secret is shown only once
SOURCE_SECRET=<secret from the response>
INGRESS_URL=<ingress_url from the response>
BODY='{"id":"evt_1","type":"order.paid"}'
SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SOURCE_SECRET" | awk '{print $2}')
curl -i -X POST "$INGRESS_URL" -H 'content-type: application/json' -H "x-signature: $SIG" -d "$BODY"
# → 202 {"event_id":"evt_..."}; then GET $API/events/<event_id> shows the delivery and its attempt
```

Destination URLs must be public HTTPS (the SSRF guard rejects private addresses), so point the destination at a real endpoint or a request bin. Verify the signature in your backend with any [Standard Webhooks library](https://github.com/standard-webhooks/standard-webhooks#reference-implementations). Source changes made with `PATCH` can take up to 30 seconds to reach ingress.

### Install with an AI coding agent

Paste this prompt into Claude Code, Codex, or a similar agent running in an empty directory. It installs and verifies a local instance, and stops before anything that touches your Cloudflare account.

```text
Install Hookflare (https://github.com/huongda-group/hookflare), an inbound webhook
gateway for Cloudflare Workers, and verify it runs locally.

1. Check prerequisites: Node.js 24 (`.nvmrc`), pnpm via `corepack enable`, git,
   openssl, curl, jq. Report anything missing instead of installing system
   packages without asking me.
2. Clone the repo (latest release: `git checkout 1.0.0`) and run `pnpm install`
   at the repository root.
3. Copy `apps/gateway/.dev.vars.example` to `apps/gateway/.dev.vars`. Set
   SECRETS_KEY to a fresh `openssl rand -base64 32` (the
   Turnstile test keys already have usable defaults). Never commit
   `.dev.vars` or print the key back to me.
4. Run `pnpm db:migrate:local`, then start `pnpm dev` in the background and
   wait until `curl http://localhost:8787/healthz` returns "status":"ok".
5. Open http://localhost:8787/setup, create the first admin (no token
   needed), then follow the README section "Receive
   your first webhook" against http://localhost:8787 (log in with
   `curl -c jar -b jar -H "origin: http://localhost:8787"`) and confirm
   ingress returns 202 with an event_id.
6. Run `pnpm test`, `pnpm typecheck`, and `pnpm lint`; report any failure with
   its output instead of changing code to make it pass.
7. Stop. Do NOT run `wrangler login`, create Cloudflare resources, set secrets,
   or deploy unless I explicitly ask. If I do, follow README "Option B" and
   `docs/runbook.md#setup` step by step, show me each command that changes my
   Cloudflare account before running it, and use `pnpm run deploy`
   (never `pnpm deploy`). If the Cloudflare API MCP server is connected, use it
   for account operations (README "Cloudflare operations with the Cloudflare
   MCP server") and wrangler only for local dev and `pnpm run deploy`.

Finish with a short summary: what was installed, the local URLs, and what is
left for a Cloudflare deployment.
```

### Cloudflare operations with the Cloudflare MCP server

For a deployed instance, give the agent the [Cloudflare API MCP server](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/) (`https://mcp.cloudflare.com/mcp`) alongside wrangler. It exposes the whole Cloudflare API through three tools: `search` (find an endpoint in the OpenAPI spec), `execute` (run JavaScript that calls the API with your OAuth grant), and `docs` (search the Cloudflare docs). Connect it in Claude Code with:

```bash
claude mcp add --transport http cloudflare https://mcp.cloudflare.com/mcp
```

The first call opens an OAuth page where you choose the account and permissions. Other MCP clients use `{"mcpServers": {"cloudflare": {"url": "https://mcp.cloudflare.com/mcp"}}}`.

| Task | Use |
|---|---|
| Create D1 databases, queues, and R2 buckets; list Workers, deployments, and versions | MCP `execute` |
| Inspect a live D1 database (`POST /accounts/{id}/d1/database/{db}/query`) | MCP `execute` |
| Workers Builds triggers: build/deploy command, branch, path filters (`/accounts/{id}/builds/triggers`) | MCP `execute` |
| Cloudflare product questions (Turnstile, Queues limits, Workflows) | MCP `docs` |
| Local dev, local D1 migrations, `wrangler types` | `pnpm` scripts (wrangler) |
| Deploys, remote migrations, rollback | `pnpm run deploy` and [`docs/runbook.md`](docs/runbook.md), never hand-made API calls, so the restore point and smoke result are recorded |

Pass the account ID explicitly when the OAuth grant covers several accounts. A write through `execute` changes the live account immediately: review every call that creates, updates, or deletes something (above all SQL against a production D1) before approving it.

The Git-connected Workers Builds trigger runs `pnpm install --frozen-lockfile` as the build command and `pnpm run deploy -- --skip-smoke` as the deploy command, because Workers Builds has no sink or API token. Run `pnpm run smoke` afterwards from a machine that has the smoke env (`HOOKFLARE_API_TOKEN` from an admin API token).

## Dashboard

Pages: Overview, Projects, Endpoints (sources and destinations), Events, Failures, Alerts, Archives, Audit log, and Settings (retry defaults, storage and backups, users). What a user can do depends on their role: **viewer** reads events and deliveries, **operator** also sees payloads, replays, and pauses/resumes destinations, **admin** also changes configuration (projects, endpoints, alert channels), manages users and settings, and reads the audit log.

For local development, run `pnpm dev` (create the first admin via the onboarding page — no token needed), plus `pnpm dev:dashboard` (Vite on port 5173, proxying `/api` to the Worker).

Production serves the dashboard from the same Worker. The first visit shows the onboarding page (`/setup`); afterwards login is username/password at `/login`, and automation uses API tokens (Settings › Users). `/in/*` and `/healthz` stay public.

## Integration

See the [wire contract](docs/contract.md) for signing, response codes, and
deduplication across retries or replay, and [delivery](docs/delivery.md) for
the retry policy and delivery states.

## Contributing

Feedback on the [roadmap](docs/roadmap.md) is welcome. Please open an issue to discuss a change before you send a pull request.

## Releases

See [`CHANGELOG.md`](CHANGELOG.md) for released versions. To run a specific release, check out its tag before installing. Use the docs in that checkout rather than assuming the current docs also apply to older releases.

## License

[MIT](LICENSE)
