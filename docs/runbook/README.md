# Hookflare operations runbook

Step-by-step procedures for deploying Hookflare, changing its database
schema, undoing a bad release, and reacting to incidents. Written for an
operator who has never seen the code.

Pages:

- [setup.md](setup.md) — create staging (or production) resources, secrets,
  the Access application, the sink, and the first deploy.
- [deploy.md](deploy.md) — the normal release path (`scripts/deploy.mjs`).
- [migrations.md](migrations.md) — expand → deploy → contract, with a worked
  rename example.
- [rollback.md](rollback.md) — decide whether to roll back, run it, verify.
- [backup-restore.md](backup-restore.md) — restore D1 via Time Travel
  (path A) or from the R2 copy (path B), and what a D1 restore means
  for R2.
- [secrets.md](secrets.md) — store `SECRETS_KEY`, re-enter secrets after
  a restore, rotate a leaked secret.
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
| Service token | A Cloudflare Access service token used by automation (smoke/bench scripts). Its identity inside Hookflare is `svc:<client id>`. |
| Restore point | The D1 Time Travel bookmark plus the Worker version recorded by `scripts/deploy.mjs` before a release changes anything. Stored in `.deploy/<timestamp>.json` (git-ignored). |
| Expand → deploy → contract | The only safe schema-change sequence: first add the new shape (expand), then deploy code that works with both shapes, then remove the old shape (contract) in a later release. |
| Rollback | `wrangler rollback <version-id>`: redeploys a previous Worker version. It does **not** undo D1 schema/data, R2 objects, queue messages, DO migrations, or API-changed settings. |
| Roll forward | Fix the bug in a new release instead of rolling back. Required when the release contains a contract or DO migration. |
