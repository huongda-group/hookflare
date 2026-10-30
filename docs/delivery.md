# Delivery, retry, and recovery state

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

An event has one initial delivery and may gain replay deliveries. Each delivery tracks its own attempts and state in D1. Terminal states are `delivered`, `failed_final`, and `dead`; active states include `pending`, `queued`, `in_flight`, `retrying`, and `paused`.

Only an actual outbound request consumes an attempt. Infrastructure errors, limiter rejection, and a paused destination do not. Retry budget is the D1 attempt count, not the queue message attempt counter. The native DLQ is a safety net.

## Design and interaction

The consumer acquires a conditional lease before sending. Completion is fenced by the acquired lease so a stale consumer cannot overwrite a newer result. Duplicate or early messages are acknowledged safely; the reconciler recovers persisted work whose enqueue or lease lifecycle was interrupted.

Default policy: timeout 10 seconds, 20 attempts, backoff base 30 seconds, cap six hours, ±20% jitter. Destination values override global defaults per field. Valid `Retry-After` on 429 is bounded by policy. The retry-delay cap is 43,200 seconds. Avoid quoting a fixed total recovery window: jitter and backend responses change it.

2xx → delivered. Retryable failures → retrying, then dead when the attempt budget is exhausted. Redirects/other 4xx and unrecoverable conditions such as missing payload or SSRF block → failed_final. Pause/resume preserves history. The destination limiter controls in-flight work and request rate without spending the attempt budget.

## Ideas, boundaries, and open work

Delivery is at-least-once, not exactly-once. A backend may have accepted a request before the gateway loses the result; consumers must be idempotent. Throughput tuning requires benchmark evidence.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/delivery/consumer.ts](../apps/gateway/src/delivery/consumer.ts)
- [apps/gateway/src/delivery/classify.ts](../apps/gateway/src/delivery/classify.ts)
- [apps/gateway/src/delivery/backoff.ts](../apps/gateway/src/delivery/backoff.ts)
- [apps/gateway/src/core/policy.ts](../apps/gateway/src/core/policy.ts)
- [apps/gateway/src/jobs/reconcile.ts](../apps/gateway/src/jobs/reconcile.ts)
- [apps/gateway/test/delivery/consumer.test.ts](../apps/gateway/test/delivery/consumer.test.ts)

