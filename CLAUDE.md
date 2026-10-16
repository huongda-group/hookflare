# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Hookflare is an inbound webhook gateway on Cloudflare (Workers + Hono, D1, Queues, R2, Durable Objects, Access). Milestones M0 (Foundation) and M1 (Core pipeline) are done: ingress, D1 ledger via Drizzle, queue consumer with single-shot delivery, Standard Webhooks signing, SSRF guard, and a minimal admin API behind Access. M2 (Reliability) is done: retries with exponential backoff, lease fencing, DLQ consumer, dedup by provider event ID, R2 payloads, per-minute reconciler, per-destination retry policy, and pause/resume. M3 (Admin API & security) is done: users + RBAC (viewer/operator/admin) with bootstrap admins, audit_logs written in the same batch as every mutation, event search and failures views with cursors, single and bulk replay, synchronous test delivery, and source/destination secret rotation with a grace window. M4 (Dashboard) is done: React SPA served as Workers Static Assets from the same Worker, every §8 page except Archives and Alerts, `stats_hourly` rollup every 5 minutes, overview and per-destination stats, and editable retry defaults in Settings. M5a (Limiter) is done: a SQLite-backed DestinationLimiter DO per destination enforces max_in_flight and rate_limit_per_s before the lease, and a rejection is a new delayed message that never counts as an attempt.

## Source documents and precedence

- `DESIGN.md`: original product/system spec.
- `docs/superpowers/specs/2026-10-14-hookflare-roadmap.md`: architecture baseline, locked decisions (DEC-1–DEC-12), and milestones M0–M6. **Where it differs from `DESIGN.md`, the roadmap wins**; §3 of the roadmap lists every deviation.
- Per-milestone specs go to `docs/superpowers/specs/YYYY-MM-DD-mN-<topic>-design.md`. Each milestone follows the cycle spec → user review → implementation plan → implementation. All docs and specs are written in English (open-source project).

## Commands

All commands run from the repository root.

| Script | Runs |
|---|---|
| `pnpm dev` | `wrangler dev` for the gateway (local D1, `.dev.vars`) |
| `pnpm dev:dashboard` | `vite` on 5173, proxying `/api` to `wrangler dev` (run `pnpm dev` alongside) |
| `pnpm build` | builds the dashboard into `apps/dashboard/dist` |
| `pnpm --filter dashboard e2e` | Playwright smoke test against `wrangler dev` |
| `pnpm test` | Vitest for every workspace |
| `pnpm typecheck` | `tsc --noEmit` for every workspace |
| `pnpm lint` / `pnpm format` | `biome check` / `biome check --write` |
| `pnpm cf-typegen` | `wrangler types --strict-vars=false` (regenerates the committed `worker-configuration.d.ts`; run it without a local `.dev.vars`, or local secrets end up in `Env` and CI fails its staleness check) |
| `pnpm db:migrate:local` | `wrangler d1 migrations apply DB --local` |
| `pnpm db:generate` | `drizzle-kit generate` from `apps/gateway/src/core/db/schema.ts` into `apps/gateway/migrations/` (never hand-edit generated migrations; CI fails on drift) |
| `pnpm db:migrate:remote` | `wrangler d1 migrations apply DB --remote` |
| `pnpm run deploy` | `build`, `db:migrate:remote`, then `wrangler deploy` |

To run a single test: `pnpm --filter gateway exec vitest run test/core/ids.test.ts -t "strictly increasing"`.

> `pnpm deploy` is a built-in pnpm command, so the deploy script must be invoked as **`pnpm run deploy`**.

## Planned architecture (big picture)

- **One Worker, three handlers** (DEC-7). `fetch` serves `/in/:sourceId` (public ingress), `/api/admin/v1/*` (behind Cloudflare Access + RBAC), and the dashboard as static assets. `queue` routes `hookflare-deliveries` batches to the delivery consumer and `hookflare-deliveries-dlq` batches to `delivery/dlq.ts`. `scheduled` runs the reconciler every minute and the rollup (`jobs/rollup.ts`) every 5 minutes; the alerts and archive/retention jobs arrive in later milestones.
- **Layout:** `apps/gateway` (Hono; modules `core/`, `ingress/`, `delivery/`, `admin/`, `jobs/`), `apps/dashboard` (React + Vite + Tailwind + TanStack), `packages/shared`. `ingress/` must not import from `admin/`, so ingress can later be split into its own Worker.
- **One deployment = one environment** (DEC-1). There is no `environment` column; staging and production are separate Workers with their own D1/R2/Queues.
- **Data access** uses Drizzle ORM (`core/db/`); handlers get `db`, `queue`, `fetch`, `resolveDns`, and `now` from the `Deps` seam (`src/deps.ts`), never from `env` directly, so tests can inject them.

## Invariants that span multiple components

- Ingress returns `202` only after the D1 write (and the R2 write, for payloads > 64 KB) **and** `QUEUE.send` have all succeeded. If D1 succeeds but the queue fails, return `503`; the reconciler later enqueues the delivery from D1. Exception: a delivery to a paused destination is stored as `paused` and not enqueued; Resume or the reconciler enqueues it later.
- Verify source signatures against the **raw body bytes**. Parse JSON (e.g. to extract the provider event ID) only after verification.
- **D1 is the source of truth for retry state.** The retry budget is `deliveries.attempt_count` compared against the destination's `max_attempts`, not the queue's `msg.attempts`, which resets on re-enqueue. Native DLQ is only a safety net.
- The consumer must acquire the conditional-UPDATE **lease** before calling a backend. If 0 rows are affected, ack and skip: that is how duplicate queue messages become harmless.
- Retries are new delayed messages; `msg.retry()` is only for infra errors and as a fallback when the reschedule send fails. A duplicate message that arrives before `next_attempt_at` is acked (never re-delayed, so it cannot reach the DLQ); the due message still arrives, and the reconciler resends it if lost.
- The record update is fenced by `lease_until`: it matches the lease value, so a stale worker whose lease expired writes neither the delivery update nor the attempt row.
- Infra errors (D1/R2), limiter rejections, and paused destinations never count as attempts.
- Replay always creates a **new** `deliveries` row (`kind=replay`) and never mutates past deliveries or attempts. Every admin mutation writes `audit_logs` with secrets redacted.
- Every admin mutation and its audit_logs row are written in one db.batch; replay audits list every new delivery ID. Permissions are checked per route with requirePermission(); the users row is read on every admin request.
- Outbound requests: HTTPS only, `redirect: "manual"`, SSRF check (DoH resolve) before every delivery, Standard Webhooks signing, and credential headers stripped via the shared denylist.
- Archival never removes an event from D1 while any of its deliveries is non-terminal, and deletes from D1 only after the R2 manifest has been verified.
- Retry defaults come from the `retry_defaults` settings row (30 s isolate cache); a destination's own policy fields override them per field.
