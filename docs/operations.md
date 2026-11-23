# Deployment, operations, and verification

[Documentation index](README.md)

## Business rules and current behavior

Operate Hookflare with separate staging and production resources. The deployment script builds, records a restore point, migrates, deploys, and smoke-tests. A first deployment may explicitly skip smoke until onboarding creates an automation account/token.

The runbook is the procedure authority. Its “verify on staging in drill” markers and pending drill records remain pending until a real run provides evidence.

## Design and interaction

Start with [runbook](runbook.md), then [setup](runbook.md#setup), [deployment](runbook.md#deploy-and-smoke), [migration safety](runbook.md#migrations), [rollback](runbook.md#rollback), [monitoring](runbook.md#monitoring), and [incident response](runbook.md#incidents).

The sink Worker (`tools/sink`) is a fake backend. `POST /r/<run>/hook` records each webhook ID (`webhook-id` header) and answers with optional `status`, `delay_ms`, and `fail_pct` (random `503`) query parameters; `GET /r/<run>/stats` merges per-run counts from 16 SQLite-backed Durable Object shards, and `?ids=1` adds the distinct webhook IDs (at most 1,000 per shard) that smoke uses to check exactly which deliveries arrived. `DELETE /r/<run>` clears a run, and sink data expires after 7 days.

The benchmark tools (`tools/bench`) only target staging. They read the production identity from `apps/gateway/wrangler.jsonc` (Worker name, D1 names and IDs, `PUBLIC_BASE_URL`, routes, `workers.dev` host) and refuse it; `HOOKFLARE_PRODUCTION_URL` can only add hosts to refuse, and there is no override flag.

- `node src/run.ts <scenario.json>` prints an offline cost estimate (gross list prices, ignoring included quotas) and sends nothing unless `--yes` is given. With `--yes` it reads `HOOKFLARE_URL`, `HOOKFLARE_API_TOKEN`, and `SINK_URL`, provisions a project, destination, and HMAC sources, fires an open-loop arrival schedule, waits for the project's backlog to drain, and writes `results/<name>-<iso>.json`. Latency is measured from each request's scheduled send time, so a stalled sender shows up as latency (no coordinated omission). Loss is `accepted − sink unique` after the drain; when events not answered with `202` were still delivered, it is a lower bound.
- `node src/seed.ts` generates synthetic events, deliveries, and attempts as SQL files under `tools/bench/results/`; it is a dry run unless `--yes` loads them into the `--config` database.
- `node src/queries.ts` times read-only admin queries (events search, failures, overview ranges, destination stats, archive preview) and reports p50/p95/max including network round trips.

Benchmark results must distinguish measured values from design targets, and local smoke from provider/live acceptance.

Validation layers: unit/integration tests for behavior, fault injection for partial failures, fixture browser tests for UI contracts, real Worker smoke for integrated journeys, and live drills for operational recovery. CI runs typecheck, lint, 100% coverage, the migration checks, and the Playwright suites. Existing reports do not establish current production state.

## Ideas, boundaries, and open work

See [runbook drills](runbook.md#drills) for outstanding live staging, benchmark, and rollout acceptance.

## Source and verification entry points

The files below define this behavior and its tests.

- [scripts/deploy.mjs](../scripts/deploy.mjs)
- [scripts/lib/deploy.mjs](../scripts/lib/deploy.mjs)
- [scripts/check-migrations.mjs](../scripts/check-migrations.mjs)
- [scripts/smoke.mjs](../scripts/smoke.mjs)
- [scripts/lib/smoke.mjs](../scripts/lib/smoke.mjs)
- [apps/gateway/src/jobs/scheduled.ts](../apps/gateway/src/jobs/scheduled.ts)
- [apps/gateway/src/core/heartbeat.ts](../apps/gateway/src/core/heartbeat.ts)
- [tools/sink/src/index.ts](../tools/sink/src/index.ts)
- [tools/bench/src/run.ts](../tools/bench/src/run.ts)
- [tools/bench/src/guard.ts](../tools/bench/src/guard.ts)
- [tools/bench/src/seed.ts](../tools/bench/src/seed.ts)
- [tools/bench/src/queries.ts](../tools/bench/src/queries.ts)
- [.github/workflows/ci.yml](../.github/workflows/ci.yml)
- [scripts/tests/deploy.test.mjs](../scripts/tests/deploy.test.mjs)
- [scripts/tests/smoke.test.mjs](../scripts/tests/smoke.test.mjs)
- [tools/sink/tests/sink.test.ts](../tools/sink/tests/sink.test.ts)
- [tools/bench/tests/guard.test.ts](../tools/bench/tests/guard.test.ts)
