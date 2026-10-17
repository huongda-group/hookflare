# Setup: staging (and production)

Create the Cloudflare resources, secrets, Access application, sink Worker,
and service-token identity for one environment, then deploy to it for the
first time. The same steps build staging and production; only names differ.

> [!NOTE]
> The steps below are derived from the repository scripts and configs but
> have **not yet been executed against live staging** — staging resources do
> not exist yet. Steps not yet run once are marked
> **(verify on staging in drill)**.

## Prerequisites

- A Cloudflare account with **Workers Paid** (14-day queue retention).
- A Cloudflare **Zero Trust** organization for Access.
- Node.js LTS, [pnpm](https://pnpm.io/), and
  [Wrangler](https://developers.cloudflare.com/workers/wrangler/).
- `pnpm install` at the repository root.
- Run Wrangler from the repository root with
  `pnpm exec wrangler … --config apps/gateway/wrangler.staging.jsonc`
  (staging) or `--config apps/gateway/wrangler.jsonc` (production),
  or `cd apps/gateway` first.

## 1. Create Cloudflare resources (verify on staging in drill)

```bash
pnpm exec wrangler d1 create hookflare-staging --config apps/gateway/wrangler.staging.jsonc
pnpm exec wrangler queues create hookflare-deliveries-staging
pnpm exec wrangler queues create hookflare-deliveries-dlq-staging
pnpm exec wrangler r2 bucket create hookflare-payloads-staging
```

(Production uses `hookflare`, `hookflare-deliveries`,
`hookflare-deliveries-dlq`, and `hookflare-payloads` with
`apps/gateway/wrangler.jsonc`.)

Put the real `database_id` from the `d1 create` output into
`apps/gateway/wrangler.staging.jsonc` → `d1_databases[0].database_id`.
The committed value is the placeholder `00000000-0000-0000-0000-000000000000`
(staging resources are not created yet, so the real ID is still pending).

The ingress rate limiter (`INGRESS_LIMITER`, 100 requests per 10 s per
source) needs no setup: `namespace_id` is any account-unique integer. The
cron triggers are declared in the config and deployed with the Worker.

## 2. Configure secrets (verify on staging in drill)

`SECRETS_KEY` is 32 random bytes, base64-encoded. Generate one with:

```bash
openssl rand -base64 32
```

Store it as a Worker secret:

```bash
pnpm exec wrangler secret put SECRETS_KEY --config apps/gateway/wrangler.staging.jsonc
```

**Keep `SECRETS_KEY` in the team password manager, with who has access.**
It is the one thing a backup cannot replace: without it every source
secret, signing secret, and channel config in a restored database is
unreadable. For local development, copy `apps/gateway/.dev.vars.example`
to `apps/gateway/.dev.vars` and fill in a key.

## 3. Protect the dashboard with Cloudflare Access (verify on staging in drill)

1. Create an Access application covering the dashboard (`/`) and the admin
   API (`/api/admin/*`).
2. Add **bypass** policies for `/in/*` and `/healthz` — webhook providers
   and uptime monitors must reach them without logging in.
3. Create a **service token** for automation (smoke/bench scripts).
4. Set in `apps/gateway/wrangler.staging.jsonc` → `vars`:
   `ACCESS_TEAM_DOMAIN` (`https://<team>.cloudflareaccess.com`),
   `ACCESS_AUD` (the application's AUD tag), and `BOOTSTRAP_ADMIN_EMAILS`
   (comma-separated). The admin API fails closed (`500`) until both Access
   values are set. If the ingress hostname differs from the admin hostname,
   set `PUBLIC_BASE_URL` (e.g. `https://hooks.example.com`) so
   `ingress_url` in admin responses points at it. For local development, set
   `ACCESS_DEV_EMAIL` in `.dev.vars`; it is honored only on `localhost`.

## 4. Deploy the sink (verify on staging in drill)

The sink (`tools/sink`) is the fake backend that smoke tests and
benchmarks deliver to. It has no auth, so every run uses a random run ID.

```bash
pnpm --filter sink run deploy
```

## 5. Add the service-token identity (verify on staging in drill)

Inside Hookflare a service token's identity is `svc:<client id>` (the
Access client ID). Add it as an operator through the dashboard Users page
(or the users API, which accepts `svc:`-prefixed IDs). Until the user
exists, automation gets `403`. Bootstrap admin emails never create `svc:`
users.

## 6. Migrate and deploy (verify on staging in drill)

```bash
pnpm deploy:staging
curl https://<your-staging-worker-domain>/healthz   # {"status":"ok","version":"..."}
```

`pnpm deploy:staging` is `node scripts/deploy.mjs --config
apps/gateway/wrangler.staging.jsonc`: it records a restore point, builds,
applies remote D1 migrations, deploys the Worker, and smoke-tests when the
smoke env vars are set. See [deploy.md](deploy.md).

## 7. Receive the first webhook

Same as production (see the root README "Receive your first webhook"
section): create a project, a destination pointing at the sink run URL, and
a source; sign the body with the source secret and `POST` it to the
`ingress_url`. Expect `202 {"event_id":"evt_..."}`.

On a deployed Worker, replace the host and drop nothing else — Access adds
the JWT for browser sessions; for `curl`, use `cloudflared access curl`.

Source changes made with `PATCH` can take up to 30 seconds to reach ingress.
