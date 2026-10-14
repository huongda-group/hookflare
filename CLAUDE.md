# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Hookflare is an inbound webhook gateway on Cloudflare (Workers + Hono, D1, Queues, R2, Durable Objects, Access). Milestone M0 (Foundation) is done: the monorepo, gateway Worker skeleton, D1 migration tooling, and core building blocks are scaffolded.

## Source documents and precedence

- `DESIGN.md`: original product/system spec.
- `docs/superpowers/specs/2026-10-14-hookflare-roadmap.md`: architecture baseline, locked decisions (DEC-1–DEC-12), and milestones M0–M6. **Where it differs from `DESIGN.md`, the roadmap wins**; §3 of the roadmap lists every deviation.
- Per-milestone specs go to `docs/superpowers/specs/YYYY-MM-DD-mN-<topic>-design.md`. Each milestone follows the cycle spec → user review → implementation plan → implementation. All docs and specs are written in English (open-source project).

## Commands

All commands run from the repository root.

| Script | Runs |
|---|---|
| `pnpm dev` | `wrangler dev` for the gateway (local D1, `.dev.vars`) |
| `pnpm test` | Vitest for every workspace |
| `pnpm typecheck` | `tsc --noEmit` for every workspace |
| `pnpm lint` / `pnpm format` | `biome check` / `biome check --write` |
| `pnpm cf-typegen` | `wrangler types --strict-vars=false` (regenerates the committed `worker-configuration.d.ts`; run it without a local `.dev.vars`, or local secrets end up in `Env` and CI fails its staleness check) |
| `pnpm db:migrate:local` | `wrangler d1 migrations apply DB --local` |
| `pnpm db:migrate:remote` | `wrangler d1 migrations apply DB --remote` |
| `pnpm run deploy` | `db:migrate:remote`, then `wrangler deploy` |

To run a single test: `pnpm --filter gateway exec vitest run test/core/ids.test.ts -t "strictly increasing"`.

> `pnpm deploy` is a built-in pnpm command, so the deploy script must be invoked as **`pnpm run deploy`**.

## Planned architecture (big picture)

- **One Worker, three handlers** (DEC-7). `fetch` serves `/in/:sourceId` (public ingress), `/api/admin/v1/*` (behind Cloudflare Access + RBAC), and the dashboard as static assets. `queue` runs the delivery consumer and the DLQ consumer. `scheduled` runs the reconcile, alerts, rollup, and archive/retention jobs.
- **Layout:** `apps/gateway` (Hono; modules `core/`, `ingress/`, `delivery/`, `admin/`, `jobs/`), `apps/dashboard` (React + Vite + Tailwind + TanStack), `packages/shared`. `ingress/` must not import from `admin/`, so ingress can later be split into its own Worker.
- **One deployment = one environment** (DEC-1). There is no `environment` column; staging and production are separate Workers with their own D1/R2/Queues.

## Invariants that span multiple components

- Ingress returns `202` only after the D1 write (and the R2 write, for payloads > 64 KB) **and** `QUEUE.send` have all succeeded. If D1 succeeds but the queue fails, return `503`; the reconciler later enqueues the delivery from D1.
- Verify source signatures against the **raw body bytes**. Parse JSON (e.g. to extract the provider event ID) only after verification.
- **D1 is the source of truth for retry state.** The retry budget is `deliveries.attempt_count` compared against the destination's `max_attempts`, not the queue's `msg.attempts`, which resets on re-enqueue. Native DLQ is only a safety net.
- The consumer must acquire the conditional-UPDATE **lease** before calling a backend. If 0 rows are affected, ack and skip: that is how duplicate queue messages become harmless.
- Infra errors (D1/R2), limiter rejections, and paused destinations never count as attempts.
- Replay always creates a **new** `deliveries` row (`kind=replay`) and never mutates past deliveries or attempts. Every admin mutation writes `audit_logs` with secrets redacted.
- Outbound requests: HTTPS only, `redirect: "manual"`, SSRF check (DoH resolve) before every delivery, Standard Webhooks signing, and credential headers stripped via the shared denylist.
- Archival never removes an event from D1 while any of its deliveries is non-terminal, and deletes from D1 only after the R2 manifest has been verified.
