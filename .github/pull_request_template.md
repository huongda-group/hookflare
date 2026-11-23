## Summary

<!-- What changes and why. -->

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm test:coverage` pass (100% coverage is enforced in CI)
- [ ] Migrations are expand-only, or the contract migration is listed in `apps/gateway/migrations/contract.json` with `release` and `reason` ([runbook](../docs/runbook.md#migrations))
- [ ] This PR does **not** change a Durable Object `migrations` block or a Workflow class — or, if it does, it is marked **roll-forward only**: `wrangler rollback` cannot undo it ([runbook](../docs/runbook.md#rollback))
- [ ] Docs describe the new behavior: the owning feature page in `docs/`, `README.md` (setup, env vars, bindings, quick start), and the public Hookflare page on the website — or N/A
- [ ] User-visible changes are noted under `[Unreleased]` in `CHANGELOG.md` — or N/A
