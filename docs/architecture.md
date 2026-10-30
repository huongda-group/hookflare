# Architecture and data model

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

A single Cloudflare Worker handles HTTP, queue batches, and scheduled jobs. Hono serves public ingress and the admin API; Workers Static Assets serves the React dashboard. D1 stores durable state, Queues triggers delivery, R2 stores larger payloads/archives/backups, a Durable Object limits destination traffic, and Workflows coordinate archive and backup jobs.

Staging and production use separate bindings and deployments. There is no environment column or environment selector. The ingress module must not depend on the admin module.

## Design and interaction

`apps/gateway` owns runtime behavior; `apps/dashboard` owns the interface; `packages/shared` owns shared validation and DTOs. `tools/sink` and `tools/bench` support verification. All human documentation belongs in root `docs`.

D1 is authoritative for delivery state and attempt budget. Conditional leases prevent duplicate queue messages from causing concurrent writes; lease fencing prevents stale workers from committing attempts. Durable persistence precedes ingress acceptance. Secrets are encrypted at rest and redacted in API responses.

Use the actual schema and migration files below for table/column names. Historical milestone migration numbers and the early `archive_days`/email-identity schema are not the current schema.

## Ideas, boundaries, and open work

Splitting ingress into a separate Worker is a future possibility, not the current deployment model. Throughput estimates are design targets until measured; see [operations](operations.md).

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/index.ts](../apps/gateway/src/index.ts)
- [apps/gateway/src/deps.ts](../apps/gateway/src/deps.ts)
- [apps/gateway/src/core/db/schema.ts](../apps/gateway/src/core/db/schema.ts)
- [apps/gateway/wrangler.jsonc](../apps/gateway/wrangler.jsonc)
- [apps/gateway/migrations](../apps/gateway/migrations)

