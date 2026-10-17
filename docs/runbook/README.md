# Hookflare operations runbook

Step-by-step procedures for deploying Hookflare, changing its database
schema, undoing a bad release, and reacting to incidents. Written for an
operator who has never seen the code.

Pages:

- [setup.md](setup.md) — create staging (or production) resources, secrets,
  the setup token, the Turnstile widget, the sink, the API token, and the
  first deploy.
- [deploy.md](deploy.md) — the normal release path (`scripts/deploy.mjs`).
- [migrations.md](migrations.md) — expand → deploy → contract, with a worked
  rename example.
- [rollback.md](rollback.md) — decide whether to roll back, run it, verify.
- [backup-restore.md](backup-restore.md) — restore D1 via Time Travel
  (path A) or from the R2 copy (path B), and what a D1 restore means
  for R2.
- [secrets.md](secrets.md) — store `SECRETS_KEY`, re-enter secrets after
  a restore, rotate a leaked secret.
- [monitoring.md](monitoring.md) — the three external checks (health,
  ingress 401 probe, dashboard redirect), the canary source, and a worked
  setup for one free uptime service.
- [incidents.md](incidents.md) — one Symptom → Check → Act → Close
  playbook per signal: every M5 alert rule, health down, ingress 5xx,
  queue backlog, D1 overload, leaked secret, dashboard lockout, and
  Cloudflare platform incident.
- `drills/` — dated records of every drill run against staging.

> [!NOTE]
> Staging commands below have **not yet been executed against live staging**
> (staging resources are not created yet; the live drill is pending). Any
> command not yet run once is marked **(verify on staging in drill)**. Do not
> treat an unmarked command as verified — check the drill records.

## Last drills

| Drill | Date | Result |
|---|---|---|
| Rollback drill ([template](drills/2026-10-XX-rollback.md)) | pending | PENDING — live staging drill not yet run |
| Restore drill ([template](drills/2026-10-XX-restore.md)) | pending | PENDING — live staging drill not yet run |
| Production rollout (M6d) | pending | not yet run |

## Glossary

| Term | Meaning |
|---|---|
| Gateway Worker | The main Hookflare Worker (`apps/gateway`): ingress, delivery, admin API, dashboard assets. |
| Sink | A tiny throwaway Worker (`tools/sink`) used as a fake backend for smoke tests and benchmarks. It records what it receives; it never verifies signatures. |
| API token | An `hf_…` Bearer token for automation (smoke/bench scripts), created in Settings › Users for a user whose role covers the calls. Exported as `HOOKFLARE_API_TOKEN`. |
| Restore point | The D1 Time Travel bookmark plus the Worker version recorded by `scripts/deploy.mjs` before a release changes anything. Stored in `.deploy/<timestamp>.json` (git-ignored). |
| Expand → deploy → contract | The only safe schema-change sequence: first add the new shape (expand), then deploy code that works with both shapes, then remove the old shape (contract) in a later release. |
| Rollback | `wrangler rollback <version-id>`: redeploys a previous Worker version. It does **not** undo D1 schema/data, R2 objects, queue messages, DO migrations, or API-changed settings. |
| Roll forward | Fix the bug in a new release instead of rolling back. Required when the release contains a contract or DO migration. |
| Canary source | An `hmac` source whose destination is the sink. Every external ingress probe uses a wrong signature, so it never stores anything — it only exercises signature verification. |
| Heartbeat | `jobs.heartbeat` in D1, written by `runScheduled` after each job. `/healthz` reports `503 jobs_stale` when `reconcile_at` is older than 5 minutes (or missing on a row older than 5 minutes), `jobs_unknown` on a fresh database. |
| Page | An alert that notifies the shared Discord/Slack channel after 2 consecutive failures. |
