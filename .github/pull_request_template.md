## Summary

<!-- What changes and why. -->

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass
- [ ] Migrations are expand-only, or the contract migration is listed in `apps/gateway/migrations/contract.json` with `release` and `reason` (docs/runbook/migrations.md)
- [ ] This PR does **not** change a Durable Object `migrations` block or a Workflow class — or, if it does, it is marked **roll-forward only**: `wrangler rollback` cannot undo it (docs/runbook/rollback.md, spec M6-10)
