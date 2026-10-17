# PENDING — live staging drill not yet run

Rollback drill record template. Fill in the time table when the drill is
run on live staging (spec §5.6 drill: deploy a version, deploy a
deliberately broken version with ingress returning 500, detect it with the
smoke test, roll back, smoke again).

## Setup

- Staging Worker URL: _
- Sink URL: _
- API token (created for an admin user; exported as `HOOKFLARE_API_TOKEN`): _
- Starting version (`wrangler deployments list --json`): _

## Steps

| # | Step | Time (UTC) | Result |
|---|---|---|---|
| 1 | Deploy `f/m6`: `pnpm deploy:staging` (record version V_good + bookmark) | | |
| 2 | Deploy throwaway broken commit (`ingressRoutes` returns 500; unpushed — `git stash` or a local branch, never committed to a pushed branch) | | |
| 3 | Smoke test fails: `pnpm smoke:staging` (non-zero; script prints rollback commands) | | |
| 4 | Run the printed rollback: `wrangler rollback V_good --config apps/gateway/wrangler.staging.jsonc` | | |
| 5 | Smoke test passes again: `pnpm smoke:staging` (exit 0, event ID + two delivery IDs) | | |

## Outcome

- Rolled-back-to version: _
- Smoke after rollback: PASS / FAIL
- Surprises / runbook fixes: _
