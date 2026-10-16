# Deploy

The normal release path. One command records a restore point, builds,
migrates, deploys, smoke-tests, and prints the exact rollback commands.

## Command

```bash
pnpm deploy:staging     # staging: node scripts/deploy.mjs --config apps/gateway/wrangler.staging.jsonc
pnpm run deploy          # production: node scripts/deploy.mjs --config apps/gateway/wrangler.jsonc
```

Both commands below are **(verify on staging in drill)** — they are derived
from `scripts/deploy.mjs` and `package.json` but have not yet been run
against live staging.

## What the script does, in order

1. **record** — runs `wrangler d1 time-travel info <d1-name> --json` and
   `wrangler deployments list --json`, and keeps the bookmark plus the
   current Worker version as the restore point. If either wrangler call
   fails, the deploy stops before changing anything.
2. **build** — runs `pnpm build` (dashboard SPA + gateway).
3. **migrate** — runs `wrangler d1 migrations apply DB --remote` with the
   selected config. Migrations only ever move forward; see
   [migrations.md](migrations.md).
4. **deploy** — runs `wrangler deploy` with the selected config, then reads
   the new version from `wrangler deployments list --json`.
5. **smoke** — runs the smoke test when `HOOKFLARE_URL`,
   `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, and `SINK_URL` are set;
   otherwise prints a warning and skips (so a first-time deployment works).
   See below.
6. **report** — writes `.deploy/<timestamp>.json` (git-ignored) with the
   timestamp, config, worker name, D1 name, deployed version, and bookmark.

## Smoke test

```bash
pnpm smoke:staging   # node scripts/smoke.mjs --config apps/gateway/wrangler.staging.jsonc (verify on staging in drill)
pnpm run smoke        # production (verify: same script, production config)
```

Export the four env vars first: `HOOKFLARE_URL` (worker origin),
`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` (service token),
`SINK_URL` (sink origin). The script reuses the project with slug `smoke`
if it exists, creates a source + destination pointed at a fresh sink run,
sends a signed webhook, and polls (up to 60 s per step) until the delivery
reaches the sink. Expected: exit 0, printing the event ID and two delivery
IDs.

## On failure

A failed step exits non-zero and prints the manual rollback commands with
the recorded values, for example:

```text
rollback: wrangler rollback <version> --config apps/gateway/wrangler.staging.jsonc
rollback: wrangler d1 time-travel restore <d1-name> --bookmark=<bookmark> --config apps/gateway/wrangler.staging.jsonc
```

The script **never runs them** — undoing a release stays a human decision,
because a rollback may be wrong when a migration already ran. Decide with
the [rollback decision table](rollback.md#decision-table), then run the
commands yourself.

## Other useful commands

```bash
# Check pending migrations without applying (verify on staging in drill):
pnpm exec wrangler d1 migrations list --remote --config apps/gateway/wrangler.staging.jsonc
# List deployed versions (run by the script's record step; verify on staging in drill):
pnpm exec wrangler deployments list --json --config apps/gateway/wrangler.staging.jsonc
```
