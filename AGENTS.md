# AGENTS.md

This file applies to all agents working in this repository. It overrides skill guidance on comments and worktrees.

## 1. Absolute no-comment rule for code

Never write comments in code. This is absolute.

Prose, explanation, rationale, TODO, FIXME, commented-out code, license headers, and JSDoc are all forbidden in source files. The project already keeps its standards, business rules, design, and boundaries in `docs/` and in this file. Code must be self-explanatory through precise naming, small functions, and explicit types. If something feels like it needs a comment, rename, extract, or document it in the owning `docs/` feature page instead.

This applies to every code file under `apps/`, `packages/`, `scripts/`, and `tools/`, including tests, styles, and markup: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.css`, `.html`.

## 2. What counts as a comment

Forbidden:

- `//` line comments
- `/* ... */` block comments
- `/** ... */` JSDoc
- `{/* ... */}` JSX comments
- `<!-- ... -->` HTML comments
- `/* ... */` CSS comments
- Dead code left behind as comments

Not comments, keep them:

- Shebang line `#!/usr/bin/env node` at the top of executable scripts
- String, template, URL, and regex contents that merely contain `//` or `#` (never break these while removing real comments)

## 3. Only narrow tool-directive exception

The single exception is a linter, formatter, compiler, coverage, or bundler directive without which `pnpm typecheck`, `pnpm lint`, or `pnpm test` fails, for example `eslint-disable`, `biome-ignore`, `@ts-expect-error`, `@ts-ignore`, `v8 ignore`, `c8 ignore`, `istanbul ignore`, or `node:coverage ignore`.

Directives are guilty until proven innocent:

- Prefer fixing the underlying lint, type, or structure over adding a directive
- Keep the directive on the narrowest scope possible with the narrowest rule name
- Never add explanation text around it, since that text is itself a comment. The only carve-out is Biome 2.x suppression syntax: its parser mandates a `: <reason>` suffix (a bare directive fails `suppressions/parse`, and an empty reason does not suppress), so keep that reason to the shortest accurate phrase and put longer rationale in the owning `docs/` page instead

## 4. Files you must not touch for this rule

- Generated code: `apps/gateway/migrations/*`, `apps/dashboard/**/routeTree.gen.ts`, `worker-configuration.d.ts`, `apps/dashboard/dist/**`
- Dependencies and build output: `node_modules/**`, `dist/**`
- Documentation and prose: `docs/**`, `*.md`, `CHANGELOG.md`
- Config comments in YAML/JSONC at the repo root are out of scope unless the task explicitly includes them

Removing comments from generated migrations breaks `drizzle-kit generate` drift checks and CI. Never hand-edit those files.

## 5. How to work here

- Work directly in the current checkout. Do not create or use git worktrees, even when a skill suggests them.
- Keep behavior identical when removing comments. Never reformat, rename, refactor, or change logic in the same edit.
- After any edit run the narrowest relevant check first (`tsc --noEmit`, `node --check`, `biome check`), then the repo checks listed under [Commands](#commands): `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- New code must ship with zero comments and with tests covering every branch, since CI enforces 100% lines, branches, functions, and statements.

## 6. Review checklist

Reject any diff that:

- Adds a comment of any kind outside the narrow directive exception
- Leaves commented-out code
- Explains `why` in code instead of in `docs/`
- Touches generated files to satisfy this rule

## Source documents and precedence

- Start at `docs/README.md`. Current documentation is organized by feature (`login.md`, `profile.md`, `contract.md`, and related pages), with business rules, design, boundaries, and source/test links.
- Code and shared schemas establish exact implemented behavior. Keep the feature document aligned when changing behavior; distinguish proposed ideas from implemented features and live acceptance.
- `docs/architecture.md` describes cross-feature decisions; `docs/roadmap.md` lists open work. `docs/runbook.md` owns operational procedures, upgrade compatibility, and drill records. Keep **(verify on staging in drill)** until a live result is recorded.
- Read `docs/README.md` and only the feature pages relevant to the task. Follow source/test links as needed. Load runbook procedures only for operational work; do not read all docs by default. Superseded plans and duplicate historical documents are intentionally removed.
- Write new docs and design changes in the root `docs` feature structure, not in module directories or a milestone-specific documentation tree. All docs and specs are written in English (open-source project).

## Commands

All commands run from the repository root.

| Script | Runs |
|---|---|
| `pnpm dev` | `wrangler dev` for the gateway (local D1, `.dev.vars`) |
| `pnpm dev:dashboard` | `vite` on 5173, proxying `/api` to `wrangler dev` (run `pnpm dev` alongside) |
| `pnpm build` | builds the dashboard into `apps/dashboard/dist` |
| `pnpm --filter dashboard e2e` | Playwright smoke test against `wrangler dev` |
| `pnpm test` | Vitest for every workspace, plus `node --test scripts/tests/*.test.mjs` |
| `pnpm test:coverage` | the same with coverage; **CI runs this and enforces 100% lines/branches/functions/statements** (gateway, dashboard, `scripts/lib`), so new code needs tests covering every branch |
| `pnpm typecheck` | `tsc --noEmit` for every workspace |
| `pnpm lint` / `pnpm format` | `biome check` / `biome check --write` |
| `pnpm cf-typegen` | `wrangler types --strict-vars=false` (regenerates the committed `worker-configuration.d.ts`; run it without a local `.dev.vars`, or local secrets end up in `Env` and CI fails its staleness check) |
| `pnpm db:migrate:local` | `wrangler d1 migrations apply DB --local` |
| `pnpm db:generate` | `drizzle-kit generate` from `apps/gateway/src/core/db/schema.ts` into `apps/gateway/migrations/` (never hand-edit generated migrations; CI fails on drift) |
| `pnpm db:migrate:remote` | `wrangler d1 migrations apply DB --remote` |
| `pnpm db:migrate:remote:staging` | the same against `wrangler.staging.jsonc` |
| `pnpm run deploy` / `pnpm deploy:staging` | `scripts/deploy.mjs`: `build`, record a restore point, remote migrations, `wrangler deploy`, smoke test (`--skip-smoke` to skip); see `docs/runbook.md#deploy-and-smoke` |
| `pnpm run smoke` / `pnpm smoke:staging` | end-to-end smoke test through the sink (needs `HOOKFLARE_URL`/`HOOKFLARE_STAGING_URL`, `HOOKFLARE_API_TOKEN` from an admin API token, `SINK_URL`) |

To run a single test: `pnpm --filter gateway exec vitest run tests/core/ids.test.ts -t "strictly increasing"`.

- Wrangler configs live in `apps/gateway/` (`wrangler.jsonc`, `wrangler.staging.jsonc`); root scripts pass `--config` for you. `scripts/ensure-dashboard-dist.mjs` writes a placeholder `apps/dashboard/dist` so `dev`, `cf-typegen`, and gateway tests work without a real dashboard build.
- Tests live in each workspace's `tests/` directory, mirroring `src/` modules (e.g. `apps/gateway/tests/delivery/`), not next to the source.
- Besides typecheck/lint/coverage, CI fails if `worker-configuration.d.ts` is stale, if migrations drift from the Drizzle schema, or if `scripts/check-migrations.mjs --base origin/main` flags an unsafe migration.

> `pnpm deploy` is a built-in pnpm command, so the deploy script must be invoked as **`pnpm run deploy`**.

## Architecture (big picture)

- **One Worker, three handlers.** See [architecture](docs/architecture.md) and [scheduled jobs](apps/gateway/src/jobs/scheduled.ts) for entry points and timing.
- **Layout:** `apps/gateway` (Hono; modules `core/`, `ingress/`, `delivery/`, `admin/`, `jobs/`), `apps/dashboard` (React + Vite + Tailwind + TanStack), `packages/shared` (zod schemas and types shared by the API and the dashboard), `tools/sink` (throwaway fake backend for smoke tests and benchmarks), `tools/bench` (load generator and seeder), `scripts/` (deploy, smoke, migration check, backup restore/verify). `ingress/` must not import from `admin/`, so ingress can later be split into its own Worker.
- **One deployment = one environment.** Staging and production use separate bindings; do not add an environment selector or column as a substitute.
- **Data access** uses Drizzle ORM (`core/db/`); handlers get `db`, `queue`, `fetch`, `resolveDns`, and `now` from the `Deps` seam (`src/deps.ts`), never from `env` directly, so tests can inject them.

## Releases

- Versions follow SemVer; tags are `X.Y.Z` (annotated, no `v` prefix) on the `main` commit that ships. A release PR adds its version, date, and links to `CHANGELOG.md` and bumps root `package.json`; create the tag after merge.
- Document user-visible changes in the owning feature page in the same PR. Keep `CHANGELOG.md` as a release index, without feature timelines or duplicate upgrade instructions.
- Keep `README.md` in sync with the code when a PR changes setup steps, bindings in `wrangler.jsonc`, env vars, or the admin API used in the quick start.

## Documentation must change with features

When a feature's behavior changes, update its documentation in the same change. A feature change is not done while any of these still describe the old behavior:

- the owning feature page in `docs/` (and `docs/README.md` if a page is added, renamed, or removed);
- `README.md` when setup, env vars, bindings, auth, or the quick-start API calls change;
- the public Hookflare page on the HĐG website: `../com/app/routes/opensource-hookflare.tsx` (VI and EN copy, quick-start commands, delivery headers, features) and its test `../com/tests/hookflare-page.test.ts`, plus `../com/docs/open-source.md`. That repo has its own rules in `../com/AGENTS.md` (no code comments, bun, its code style).

Verify quick-start commands against a running local instance before publishing them; do not copy them from older docs.

## Invariants that span multiple components

- Ingress returns `202` only after the D1 write (and the R2 write, for payloads > 64 KB) **and** `QUEUE.send` have all succeeded. If D1 succeeds but the queue fails, return `503`; the reconciler later enqueues the delivery from D1. Exception: a delivery to a paused destination is stored as `paused` and not enqueued; Resume or the reconciler enqueues it later.
- Verify source signatures against the **raw body bytes**. Parse JSON (e.g. to extract the provider event ID) only after verification.
- **D1 is the source of truth for retry state.** The retry budget is `deliveries.attempt_count` compared against the destination's `max_attempts`, not the queue's `msg.attempts`, which resets on re-enqueue. Native DLQ is only a safety net.
- The consumer must acquire the conditional-UPDATE **lease** before calling a backend. If 0 rows are affected, ack and skip: that is how duplicate queue messages become harmless.
- Retries are new delayed messages; `msg.retry()` is only for infra errors and as a fallback when the reschedule send fails. A duplicate message that arrives before `next_attempt_at` is acked (never re-delayed, so it cannot reach the DLQ); the due message still arrives, and the reconciler resends it if lost.
- The record update is fenced by `lease_until`: it matches the lease value, so a stale worker whose lease expired writes neither the delivery update nor the attempt row.
- Infra errors (D1/R2), limiter rejections, and paused destinations never count as attempts.
- Replay creates a **new** `deliveries` row (`kind=replay`) and never mutates past deliveries or attempts. Replay audits list every new delivery ID.
- Batch database mutations with redacted audit rows; external workflow starts cannot use the same transaction. See [audit](docs/audit.md). Enforce permissions per route with `requirePermission()`; authentication checks the current user. Login/setup run Origin, rate limit, and any required Turnstile check before password hashing.
- Outbound requests: HTTPS only, `redirect: "manual"`, SSRF check (DoH resolve) before every delivery, Standard Webhooks signing, and credential headers stripped via the shared denylist.
- Archival never removes an event from D1 while any delivery is non-terminal. When archive files are enabled, verify the R2 manifest before purging D1.
- The R2 backup copy is not a point-in-time snapshot: tables are read minutes apart, so a path-B restore skips rows whose parent is missing and reports them in `orphans.json`, and `verify-restore.mjs` must pass before cutover.
- A D1 restore never touches R2: events restored without their payload objects surface as `payload_missing`, post-restore-point archive batches stay in R2 unlisted, and `SECRETS_KEY` must be re-entered — a backup cannot replace it.
- Archive: purge rechecks the batch mark and eligibility; replay clears the mark.
- Retry defaults come from the `retry_defaults` settings row (30 s isolate cache); a destination's own policy fields override them per field.
- Alert channels only post to the allowlisted Discord/Slack/Telegram endpoints; channel configs are encrypted and never returned.
