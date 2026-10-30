# Changelog

All notable changes to Hookflare are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Reliability Console shell, incident-first Overview with historical-period failure labels and live-state separation, responsive recent events, and event delivery timeline/inspector with delivery-scoped attempt selection and permission-aware recovery. Browser acceptance covers desktop/narrow containment, explicit payload access, and replay keyboard focus; the approved visual reference and implementation decisions are documented in `docs/dashboard-reliability-console.md` and `docs/dashboard.md`.
- Light dashboard redesign: single light theme with documented,
  contrast-computed tokens (`docs/dashboard.md`; author-side check,
  not a certification), responsive sidebar/drawer cutover at
  1024px, skip link, keyboard-operable recovery flows, role-matrix UI
  gating, explicit payload reveal, and one-time secret acknowledgement.
  Browser coverage is split: `e2e/redesign.spec.ts` (route-intercepted
  fixtures, no real D1) and `e2e/smoke.spec.ts` (real Worker + fresh D1,
  sequential).

### Breaking

- Cloudflare Access is removed as the auth layer: the Worker no longer
  reads Access JWTs, and `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`,
  `ACCESS_DEV_EMAIL`, `BOOTSTRAP_ADMIN_EMAILS`, and the `jose` dependency
  are gone. Dashboard login is username/password with server-side
  sessions; automation uses API tokens. An admin password reset revokes
  the user's sessions and API tokens; a self-service change keeps tokens.
- Identity is now the username: `users` is keyed by `username` (existing
  emails stay valid as usernames), and `email` → `username` everywhere,
  including `actor_email` → `actor` in audit logs and the API.
- Smoke tests and the bench tool authenticate with `HOOKFLARE_API_TOKEN`
  (Bearer) instead of `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`.
- A first deploy needs `SETUP_TOKEN` (one-time onboarding that creates
  the first admin) instead of a Zero Trust application; Turnstile
  (`TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`) on the login and
  onboarding forms is recommended but optional.

### Upgrade notes (2.0.0)

1. Apply the D1 migrations: existing `users` and `audit_logs` rows
   migrate losslessly (emails become usernames; service identities
   become disabled rows that can never log in).
2. Set `SETUP_TOKEN` (`wrangler secret put SETUP_TOKEN`), open the
   Worker URL, and claim the first admin on the onboarding page — a
   migrated database has no password hashes yet, so setup is open once.
   Then set passwords for the other users (Settings › Users) and delete
   `SETUP_TOKEN`.
3. Create an API token for automation (Settings › Users) and export it
   as `HOOKFLARE_API_TOKEN` where the smoke/bench runs.
4. Optionally create a Turnstile widget for the Worker hostname and set
   `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` (see
   `docs/runbook.md#setup`). Without both, the login pages show a
   "Turnstile is off" notice.
5. The Zero Trust Access application in front of the Worker is no longer
   needed — remove it, or keep it as a network gate (Hookflare ignores
   its JWT).
6. The migration renames columns in place (`email` → `username`,
   `actor_email` → `actor`), so it is a contract migration: once it has
   run, a 1.x Worker cannot use the database. Rolling back below 2.0.0
   means a D1 Time Travel restore to the bookmark the deploy printed,
   then `wrangler rollback` (see `docs/runbook.md#rollback`).

### Changed

- The ten pre-release D1 migrations are squashed into one baseline,
  `0000_init.sql`; `migrations/squashed.json` lets the CI migration check
  accept the removal. A database created before the squash must be
  recreated (see `docs/runbook.md#migrations`).
- Workers Builds deploys run `pnpm run deploy -- --skip-smoke`
  (`docs/runbook.md#deploy-and-smoke`).

## [1.0.0] - 2026-10-17

First release. Milestones M0–M6 of the
[roadmap](docs/roadmap.md).

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
  [`docs/runbook.md`](docs/runbook.md).

### Known limitations

- The live staging drills (rollback, restore, canary) have not been run yet;
  runbook steps not yet run live are marked **(verify on staging in drill)**.
- Benchmark B6 and the recommended-limits results document are pending.

[Unreleased]: https://github.com/huongda-group/hookflare/compare/1.0.0...HEAD
[1.0.0]: https://github.com/huongda-group/hookflare/releases/tag/1.0.0
