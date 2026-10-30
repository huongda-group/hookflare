# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**1.0.0 is released** (git tag `1.0.0`, see `CHANGELOG.md`). Hookflare is an inbound webhook gateway on Cloudflare (Workers + Hono, D1, Queues, R2, Durable Objects, Workflows, built-in auth). All milestones M0–M6 are code-complete, and M7 (built-in auth) is implemented on top, unreleased (→ 2.0.0, see `CHANGELOG.md` `## [Unreleased]`):

- **M0–M2 (pipeline & reliability):** ingress with signature verification, D1 ledger via Drizzle, queue consumer, Standard Webhooks signing, SSRF guard, retries with exponential backoff, lease fencing, DLQ consumer, dedup by provider event ID, R2 payloads, per-minute reconciler, per-destination retry policy, pause/resume.
- **M3 (admin & security):** users + RBAC (viewer/operator/admin), `audit_logs` in the same batch as every mutation, event search and failures views with cursors, single and bulk replay, synchronous test delivery, source/destination secret rotation with a grace window. (M3 used Cloudflare Access + bootstrap-admin emails as the identity source; M7 replaced that with built-in login — see the M7 bullet.)
- **M7 (built-in auth):** username/password login with server-side sessions in D1, one-time onboarding protected by `SETUP_TOKEN`, API tokens for automation, Turnstile on the login/setup forms, smoke/bench via `HOOKFLARE_API_TOKEN`. Access is removed (its `ACCESS_*` vars, bootstrap admin emails, and the JWT dependency); identity is the username (`actor`, not `actor_email`, in audit logs).
- **M4 (dashboard):** React SPA served as Workers Static Assets from the same Worker, `stats_hourly` rollup every 5 minutes, overview and per-destination stats, editable retry defaults.
- **M5 (operations):** `DestinationLimiter` DO (max_in_flight, rate_limit_per_s; a rejection never counts as an attempt); alerts job with Discord/Slack/Telegram channels through an outbox; daily `ArchiveWorkflow` (gzip NDJSON + verified manifest in R2, then purge D1) with the Archives page.
- **M6 (production readiness):** staging config, `scripts/deploy.mjs` (restore point → build → migrate → deploy → smoke), migration safety check in CI, sink Worker and load generator (`tools/sink`, `tools/bench`), daily `BackupWorkflow` + restore/verify scripts, `/healthz` job heartbeat, and the runbook in `docs/runbook.md`.

Still pending after 1.0.0: the live staging drills (rollback, restore, canary), benchmark B6 and the recommended-limits results document, and the M6d production rollout. Runbook steps not yet run live are marked **(verify on staging in drill)** — keep that marker until a dated drill record in `docs/runbook.md#drills` proves otherwise.

## Source documents and precedence

- Start at `docs/README.md`. Current documentation is organized by feature (`login.md`, `profile.md`, `contract.md`, and related pages), with business rules, design, boundaries, and source/test links.
- Code and shared schemas establish exact implemented behavior. Keep the feature document aligned when changing behavior; distinguish proposed ideas from implemented features and live acceptance.
- `docs/architecture.md` and `docs/roadmap.md` describe cross-feature decisions and open work. `docs/runbook.md` owns operational procedures and pending drill records.
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
| `pnpm test` | Vitest for every workspace, plus `node --test scripts/test/*.test.mjs` |
| `pnpm typecheck` | `tsc --noEmit` for every workspace |
| `pnpm lint` / `pnpm format` | `biome check` / `biome check --write` |
| `pnpm cf-typegen` | `wrangler types --strict-vars=false` (regenerates the committed `worker-configuration.d.ts`; run it without a local `.dev.vars`, or local secrets end up in `Env` and CI fails its staleness check) |
| `pnpm db:migrate:local` | `wrangler d1 migrations apply DB --local` |
| `pnpm db:generate` | `drizzle-kit generate` from `apps/gateway/src/core/db/schema.ts` into `apps/gateway/migrations/` (never hand-edit generated migrations; CI fails on drift) |
| `pnpm db:migrate:remote` | `wrangler d1 migrations apply DB --remote` |
| `pnpm db:migrate:remote:staging` | the same against `wrangler.staging.jsonc` |
| `pnpm run deploy` / `pnpm deploy:staging` | `scripts/deploy.mjs`: record a restore point, `build`, remote migrations, `wrangler deploy`, smoke test (`--skip-smoke` to skip); see `docs/runbook.md#deploy-and-smoke` |
| `pnpm run smoke` / `pnpm smoke:staging` | end-to-end smoke test through the sink (needs `HOOKFLARE_URL`/`HOOKFLARE_STAGING_URL`, `HOOKFLARE_API_TOKEN` from an admin API token, `SINK_URL`) |

To run a single test: `pnpm --filter gateway exec vitest run test/core/ids.test.ts -t "strictly increasing"`.

> `pnpm deploy` is a built-in pnpm command, so the deploy script must be invoked as **`pnpm run deploy`**.

## Architecture (big picture)

- **One Worker, three handlers** (DEC-7). `fetch` serves `/in/:sourceId` (public ingress), `/api/admin/v1/*` (session cookie or API token + RBAC), and the dashboard as static assets. `queue` routes `hookflare-deliveries` batches to the delivery consumer and `hookflare-deliveries-dlq` batches to `delivery/dlq.ts`. `scheduled` runs the reconciler and the alerts job every minute, the rollup (`jobs/rollup.ts`) every 5 minutes, starts the archive workflow at `0 3 * * *` and the backup workflow at `0 20 * * *` (skipped while `backup_enabled` is off); the Worker also exports the `DestinationLimiter` DO and the `ArchiveWorkflow` and `BackupWorkflow` Workflow classes.
- **Layout:** `apps/gateway` (Hono; modules `core/`, `ingress/`, `delivery/`, `admin/`, `jobs/`), `apps/dashboard` (React + Vite + Tailwind + TanStack), `packages/shared` (zod schemas and types shared by the API and the dashboard), `tools/sink` (throwaway fake backend for smoke tests and benchmarks), `tools/bench` (load generator and seeder), `scripts/` (deploy, smoke, migration check, backup restore/verify). `ingress/` must not import from `admin/`, so ingress can later be split into its own Worker.
- **One deployment = one environment** (DEC-1). There is no `environment` column; staging and production are separate Workers with their own D1/R2/Queues.
- **Data access** uses Drizzle ORM (`core/db/`); handlers get `db`, `queue`, `fetch`, `resolveDns`, and `now` from the `Deps` seam (`src/deps.ts`), never from `env` directly, so tests can inject them.

## Releases

- Versions follow SemVer; tags are `X.Y.Z` (annotated, no `v` prefix) on the `main` commit that ships, and each release has a section in `CHANGELOG.md` (Keep a Changelog format). The root `package.json` `version` matches the latest tag.
- Update `CHANGELOG.md` (`## [Unreleased]`) in the same PR as any user-visible change. A release PR moves `Unreleased` under the new version and bumps `package.json`; the tag is created after it merges.
- Keep `README.md` in sync with the code when a PR changes setup steps, bindings in `wrangler.jsonc`, env vars, or the admin API used in the quick start.

## Invariants that span multiple components

- Ingress returns `202` only after the D1 write (and the R2 write, for payloads > 64 KB) **and** `QUEUE.send` have all succeeded. If D1 succeeds but the queue fails, return `503`; the reconciler later enqueues the delivery from D1. Exception: a delivery to a paused destination is stored as `paused` and not enqueued; Resume or the reconciler enqueues it later.
- Verify source signatures against the **raw body bytes**. Parse JSON (e.g. to extract the provider event ID) only after verification.
- **D1 is the source of truth for retry state.** The retry budget is `deliveries.attempt_count` compared against the destination's `max_attempts`, not the queue's `msg.attempts`, which resets on re-enqueue. Native DLQ is only a safety net.
- The consumer must acquire the conditional-UPDATE **lease** before calling a backend. If 0 rows are affected, ack and skip: that is how duplicate queue messages become harmless.
- Retries are new delayed messages; `msg.retry()` is only for infra errors and as a fallback when the reschedule send fails. A duplicate message that arrives before `next_attempt_at` is acked (never re-delayed, so it cannot reach the DLQ); the due message still arrives, and the reconciler resends it if lost.
- The record update is fenced by `lease_until`: it matches the lease value, so a stale worker whose lease expired writes neither the delivery update nor the attempt row.
- Infra errors (D1/R2), limiter rejections, and paused destinations never count as attempts.
- Replay always creates a **new** `deliveries` row (`kind=replay`) and never mutates past deliveries or attempts. Every admin mutation writes `audit_logs` with secrets redacted.
- Every admin mutation and its audit_logs row are written in one db.batch; replay audits list every new delivery ID. Permissions are checked per route with requirePermission(); the users row is read on every admin request; login/setup run Origin → limiter → Turnstile → hash.
- Outbound requests: HTTPS only, `redirect: "manual"`, SSRF check (DoH resolve) before every delivery, Standard Webhooks signing, and credential headers stripped via the shared denylist.
- Archival never removes an event from D1 while any of its deliveries is non-terminal, and deletes from D1 only after the R2 manifest has been verified.
- The R2 backup copy is not a point-in-time snapshot: tables are read minutes apart, so a path-B restore skips rows whose parent is missing and reports them in `orphans.json`, and `verify-restore.mjs` must pass before cutover.
- A D1 restore never touches R2: events restored without their payload objects surface as `payload_missing`, post-restore-point archive batches stay in R2 unlisted, and `SECRETS_KEY` must be re-entered — a backup cannot replace it.
- Archive: an event is deleted only while it is still marked for a verified batch and still eligible; replay clears the mark.
- Retry defaults come from the `retry_defaults` settings row (30 s isolate cache); a destination's own policy fields override them per field.
- Alert channels only post to the allowlisted Discord/Slack/Telegram endpoints; channel configs are encrypted and never returned.
