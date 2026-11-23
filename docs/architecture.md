# Architecture and data model

[Documentation index](README.md)

## Business rules and current behavior

A single Cloudflare Worker handles HTTP, queue batches, and scheduled jobs. Hono serves public ingress (`/in/*`), the admin API (`/api/admin/v1/*`), and `/healthz`; Workers Static Assets serves the React dashboard for every other path. Bindings:

| Binding | Role |
| --- | --- |
| `DB` (D1) | Durable state and source of truth for delivery and retry state |
| `QUEUE` | Delivery messages; its dead-letter queue is a safety net consumed by the same Worker. A batch whose queue is named `hookflare-deliveries-dlq` or `hookflare-deliveries-dlq-<suffix>` (for example `-staging`) goes to the DLQ handler, every other batch to the delivery consumer |
| `PAYLOADS` (R2) | Payloads over 64 KB and [archive](archives.md) files |
| `BACKUPS` (R2) | [Backups](backup-restore.md) |
| `LIMITER` (Durable Object `DestinationLimiter`) | One limiter per destination |
| `ARCHIVE`, `BACKUP` (Workflows) | Archive and backup runs |
| `INGRESS_LIMITER`, `LOGIN_LIMITER` (rate limits) | Ingress and login/setup rate limits |

Staging and production use separate bindings and deployments. There is no environment column or environment selector. The ingress module must not import from the admin module (a Biome rule enforces it), so ingress can later run as its own Worker.

The scheduled handler dispatches on the cron expression:

| Cron (UTC) | Jobs |
| --- | --- |
| `* * * * *` | Reconcile lost or stuck deliveries ([delivery](delivery.md)), then [alerts](alerts.md), then purge expired sessions |
| `*/5 * * * *` | Statistics rollup ([overview](overview.md)) |
| `0 3 * * *` | Start the archive Workflow ([archives](archives.md)) |
| `0 20 * * *` | Start the backup Workflow when enabled and none is running ([backups](backup-restore.md)) |

Each job is idempotent and isolated: a failure is logged and the next tick starts over, and one job's failure does not stop the next job in the same tick. Reconcile, alerts, rollup, and the backup start record a heartbeat in the `jobs.heartbeat` settings row after succeeding (backup also when it is disabled or skipped); a heartbeat write failure is logged, never fails the job. `/healthz` reports `jobs_stale` when the reconcile heartbeat is more than five minutes old (see [monitoring](runbook.md#monitoring)).

## Design and interaction

`apps/gateway` owns runtime behavior; `apps/dashboard` owns the interface; `packages/shared` owns shared validation and DTOs. `tools/sink` and `tools/bench` support verification. All human documentation belongs in root `docs`.

Handlers and jobs receive `db`, `queue`, `payloads`, `backups`, `fetch`, `resolveDns`, `now`, `limiter`, and the Workflow bindings through `Deps` ([deps.ts](../apps/gateway/src/deps.ts)), never from `env` directly, so tests can stub network, DNS, and time and inject storage faults. Job modules import only `core/`, `deps`, and their own module. Workflow orchestration code outside a step is deterministic, because Workflows replays it: time, settings, table lists, and loop cursors come from persisted step results.

D1 is authoritative for delivery state and attempt budget. Conditional leases prevent duplicate queue messages from causing concurrent writes; lease fencing prevents stale workers from committing attempts. Durable persistence precedes ingress acceptance. Secrets are encrypted at rest and redacted in API responses.

Use the schema and migration files below for table and column names. See [migration safety](runbook.md#migrations) for compatibility across releases.

## Ideas, boundaries, and open work

Splitting ingress into a separate Worker is a future possibility, not the current deployment model. Throughput estimates are design targets until measured; see [operations](operations.md).

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/index.ts](../apps/gateway/src/index.ts)
- [apps/gateway/src/app.ts](../apps/gateway/src/app.ts)
- [apps/gateway/src/jobs/scheduled.ts](../apps/gateway/src/jobs/scheduled.ts)
- [apps/gateway/src/core/heartbeat.ts](../apps/gateway/src/core/heartbeat.ts)
- [apps/gateway/src/deps.ts](../apps/gateway/src/deps.ts)
- [apps/gateway/src/core/db/schema.ts](../apps/gateway/src/core/db/schema.ts)
- [apps/gateway/wrangler.jsonc](../apps/gateway/wrangler.jsonc)
- [apps/gateway/wrangler.staging.jsonc](../apps/gateway/wrangler.staging.jsonc)
- [apps/gateway/migrations](../apps/gateway/migrations)
- [biome.json](../biome.json)
- [apps/gateway/tests/jobs/scheduled.test.ts](../apps/gateway/tests/jobs/scheduled.test.ts)
- [apps/gateway/tests/deps.test.ts](../apps/gateway/tests/deps.test.ts)
