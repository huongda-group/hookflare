# Deployment, operations, and verification

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

Operate Hookflare with separate staging and production resources. The deployment script records a restore point, builds, migrates, deploys, and smoke-tests. A first deployment may explicitly skip smoke until onboarding creates an automation account/token.

The runbook is the procedure authority. Its “verify on staging in drill” markers and pending drill records remain pending until a real run provides evidence.

## Design and interaction

Start with [runbook](runbook.md), then [setup](runbook.md#setup), [deployment](runbook.md#deploy-and-smoke), [migration safety](runbook.md#migrations), [rollback](runbook.md#rollback), [monitoring](runbook.md#monitoring), and [incident response](runbook.md#incidents).

The sink Worker and benchmark runner exercise controlled backend scenarios. Benchmark results must distinguish measured values from design targets, and local smoke from provider/live acceptance.

Validation layers: unit/integration tests for behavior, fault injection for partial failures, fixture browser tests for UI contracts, real Worker smoke for integrated journeys, and live drills for operational recovery. Existing historical reports do not establish current production state.

## Ideas, boundaries, and open work

The repository's release notes retain pending staging drills, B6/recommended limits, and production-readiness acceptance. Do not mark them completed during a documentation-only reorganization.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [scripts/deploy.mjs](../scripts/deploy.mjs)
- [scripts/check-migrations.mjs](../scripts/check-migrations.mjs)
- [scripts/smoke.mjs](../scripts/smoke.mjs)
- [apps/gateway/src/jobs/scheduled.ts](../apps/gateway/src/jobs/scheduled.ts)
- [apps/gateway/src/core/heartbeat.ts](../apps/gateway/src/core/heartbeat.ts)
- [tools/bench/src/run.ts](../tools/bench/src/run.ts)
- [.github/workflows/ci.yml](../.github/workflows/ci.yml)

