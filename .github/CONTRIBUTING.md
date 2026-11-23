# Contributing to Hookflare

Thanks for your interest in improving Hookflare.

## Getting started

1. Install Node.js (version in `.nvmrc`) and pnpm (version in `package.json` `packageManager`).
2. `pnpm install`
3. `pnpm db:migrate:local` then `pnpm dev` (and `pnpm dev:dashboard` for the dashboard).

See the [README](../README.md) for setup details and [docs/README.md](../docs/README.md) for feature documentation.

## Before opening a pull request

- `pnpm typecheck`, `pnpm lint`, and `pnpm test:coverage` must pass. CI enforces 100% line, branch, function, and statement coverage, so new code needs tests for every branch.
- Tests live in each workspace's `tests/` directory, mirroring `src/`.
- Do not hand-edit generated migrations; run `pnpm db:generate`. Migrations must be expand-only unless listed in `apps/gateway/migrations/contract.json` (see the [runbook](../docs/runbook.md#migrations)).
- Run `pnpm cf-typegen` without a local `.dev.vars` when bindings change, and commit `worker-configuration.d.ts`.
- Update the owning feature page in `docs/` and `README.md` in the same PR when behavior, setup, or bindings change.
- Source code does not contain comments; see [AGENTS.md](../AGENTS.md).

## Releases

Versions follow SemVer and tags are `X.Y.Z` (no `v` prefix). A release PR bumps `package.json` and adds the version to `CHANGELOG.md`; pushing the tag on `main` creates the GitHub release.
