# Changelog

All notable changes to Hookflare are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-17

First release. Milestones M0–M6 of the
[roadmap](docs/superpowers/specs/2026-10-14-hookflare-roadmap.md).

### Added

- **Core pipeline (M0, M1):** pnpm monorepo, one Worker (Hono) with `fetch`,
  `queue`, and `scheduled` handlers; public ingress at `/in/:sourceId` with
  `hmac`, `token`, and `none` verification on the raw body; D1 ledger via
  Drizzle; delivery through Cloudflare Queues with
  [Standard Webhooks](https://www.standardwebhooks.com/) signing; HTTPS-only
  destinations with an SSRF guard (DoH resolve) and credential headers
  stripped.
- **Reliability (M2):** retries as new delayed messages with exponential
  backoff and jitter (`Retry-After` honored), retry budget in D1, lease
  fencing, DLQ consumer, dedup by provider event ID (header or JSON path),
  payloads over 64 KB in R2, per-minute reconciler, per-destination retry
  policy, and pause/resume.
- **Admin API & security (M3):** Cloudflare Access + RBAC (viewer, operator,
  admin) with bootstrap admins, an audit log written with every mutation,
  event search and failures views, single and bulk replay, synchronous test
  delivery, and source/destination secret rotation with a grace window.
- **Dashboard (M4):** React SPA served as Workers Static Assets from the same
  Worker, overview and per-destination stats (`stats_hourly` rollup every
  5 minutes), and editable retry defaults.
- **Operations (M5):** `DestinationLimiter` Durable Object (max in-flight and
  rate limit per destination); alert rules with Discord, Slack, and Telegram
  channels; daily `ArchiveWorkflow` to R2 with verified manifests, retention
  settings, and the Archives page.
- **Production readiness (M6):** staging config, `scripts/deploy.mjs`
  (restore point, build, migrate, deploy, smoke, rollback commands), smoke
  test, migration safety check in CI, sink Worker and load generator, daily
  `BackupWorkflow` to R2 with restore and verify scripts, `backup_stale`
  alert, `/healthz` job heartbeat, and the operations runbook in
  [`docs/runbook/`](docs/runbook/).

### Known limitations

- The live staging drills (rollback, restore, canary) have not been run yet;
  runbook steps not yet run live are marked **(verify on staging in drill)**.
- Benchmark B6 and the recommended-limits results document are pending.

[Unreleased]: https://github.com/huongda-group/hookflare/compare/1.0.0...HEAD
[1.0.0]: https://github.com/huongda-group/hookflare/releases/tag/1.0.0
