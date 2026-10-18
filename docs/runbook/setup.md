# Setup: staging (and production)

Create the Cloudflare resources, secrets, setup token, Turnstile widget,
sink Worker, and API token for one environment, then deploy to it for the
first time. The same steps build staging and production; only names differ.

> [!NOTE]
> The steps below are derived from the repository scripts and configs but
> have **not yet been executed against live staging** — staging resources do
> not exist yet. Steps not yet run once are marked
> **(verify on staging in drill)**.

## Prerequisites

- A Cloudflare account with **Workers Paid** (14-day queue retention).
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

## 3. Set the setup token and Turnstile (verify on staging in drill)

`SETUP_TOKEN` protects the first-admin onboarding page: whoever opens a
fresh deployment first could otherwise claim the admin account. Generate
one and store it as a Worker secret:

```bash
openssl rand -base64 32
pnpm exec wrangler secret put SETUP_TOKEN --config apps/gateway/wrangler.staging.jsonc
```

After onboarding succeeds the token is no longer used (it can be deleted
with `wrangler secret delete SETUP_TOKEN`). If it is unset, setup fails
with `setup_token_missing` and the page explains the one command to set it.

Turnstile (recommended, optional) protects the login and onboarding forms
against bots. Create a widget for the Worker's hostname — in the
Cloudflare dashboard (Turnstile → Add widget), or via the Cloudflare API
MCP server (`POST /accounts/{id}/challenges/widgets` with the Worker
hostname as domain, `mode: "managed"`) — then set the site key in
`apps/gateway/wrangler.staging.jsonc` → `vars` (`TURNSTILE_SITE_KEY`) and
the secret key as a Worker secret
(`wrangler secret put TURNSTILE_SECRET_KEY`). Both must be set, or
neither: with neither set the pages show a "Turnstile is off" notice;
with only one set, login and setup fail closed. Production keys come from
the widget; local dev uses the always-pass test keys in
`apps/gateway/.dev.vars.example`.

If the ingress hostname differs from the admin hostname, set
`PUBLIC_BASE_URL` (e.g. `https://hooks.example.com`) so `ingress_url` in
admin responses points at it.

## 4. Deploy the sink (verify on staging in drill)

The sink (`tools/sink`) is the fake backend that smoke tests and
benchmarks deliver to. It has no auth, so every run uses a random run ID.

```bash
pnpm --filter sink run deploy
```

## 5. Create the API token for automation (verify on staging in drill)

Smoke and bench scripts authenticate with an API token (`HOOKFLARE_API_TOKEN`,
sent as `Authorization: Bearer …`), since scripts cannot solve Turnstile.
After the first deploy and onboarding (step 6), log in as the admin, open
Settings › Users, and create an API token for the smoke user (role
`admin`: the smoke creates projects, destinations, and sources). The
secret is shown once — export it as `HOOKFLARE_API_TOKEN` on the machine
that runs the smoke. Until the token exists, deploy with `--skip-smoke`
and run `pnpm smoke:staging` afterwards.

## 6. Migrate and deploy (verify on staging in drill)

```bash
pnpm deploy:staging -- --skip-smoke   # first deploy: no account or API token exists yet
curl https://<your-staging-worker-domain>/healthz   # {"status":"ok","version":"..."}
```

Then open the Worker URL, create the first admin on the onboarding page
(it asks for `SETUP_TOKEN`), and create the API token from step 5. Later
deploys run the smoke test; see [deploy.md](deploy.md).

`pnpm deploy:staging` is `node scripts/deploy.mjs --config
apps/gateway/wrangler.staging.jsonc`: it records a restore point, builds,
applies remote D1 migrations, deploys the Worker, and smoke-tests when the
smoke env vars are set. See [deploy.md](deploy.md).

## 7. Receive the first webhook

Same as production (see the root README "Receive your first webhook"
section): create a project, a destination pointing at the sink run URL, and
a source; sign the body with the source secret and `POST` it to the
`ingress_url`. Expect `202 {"event_id":"evt_..."}`.

On a deployed Worker, replace the host and authenticate with the API
token (`-H "authorization: Bearer $HOOKFLARE_API_TOKEN"`).

Source changes made with `PATCH` can take up to 30 seconds to reach ingress.
