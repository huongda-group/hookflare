# Delivery, retry, and recovery state

[Documentation index](README.md)

## Business rules and current behavior

An event has one initial delivery and may gain replay deliveries. Ingress writes the event and its initial delivery in one D1 batch, so neither exists without the other. Each delivery tracks its own attempts and state in D1. Terminal states are `delivered`, `failed_final`, and `dead`; active states are `pending`, `queued`, `in_flight`, `retrying`, and `paused`. `next_attempt_at` is set only while `retrying`, and `lease_until` only while `in_flight`.

Only an actual outbound request consumes an attempt. Infrastructure errors (D1, R2, DNS resolver, limiter, or a missing or malformed `SECRETS_KEY`), limiter rejections, and a paused destination do not. A retrying delivery is leased only once `next_attempt_at` is due, so a duplicate message never cuts a backoff short; an early duplicate is acknowledged rather than re-delayed, so it cannot drift toward the DLQ. The retry budget is the D1 attempt count compared with `max_attempts`, not the queue message attempt counter, which resets on every re-enqueue.

## Design and interaction

The consumer loads the delivery and skips (acknowledges) anything not claimable: unknown, terminal, or `in_flight` under a live lease. It then checks the destination: `paused` parks the delivery as `paused`; `disabled` ends it as `failed_final` (`destination_disabled`). Next it takes a [limiter](destinations.md) slot when the destination has limits, loads the payload, runs the SSRF check, and signs, so a limiter rejection repeats none of that work. Only then does it acquire the conditional lease (`in_flight` until the timeout plus 30 seconds); if another worker holds it, the message is acknowledged. The attempt row, the delivery update, and the destination's consecutive-failure counter are written in one batch fenced by that lease, so a stale worker whose lease expired writes nothing.

A missing payload, an SSRF block, or an undecryptable stored signing secret ends the delivery as `failed_final` without an attempt, because retrying cannot fix it. Infrastructure errors call `msg.retry()` with a delay of 60 seconds doubling to at most one hour. After 20 consecutive infrastructure retries of one message, the queue moves it to the DLQ, whose consumer marks the delivery `dead` (`dlq: infra retries exhausted`) only if it is claimable and due. Malformed queue messages are dropped, and an unexpected error in one message never retries the rest of its batch.

Default policy: timeout 10 seconds, 20 attempts, backoff base 30 seconds, cap six hours, ±20% jitter. The delay after failed attempt *n* is `min(base · 2^(n−1), max)` with jitter, bounded to 1–43,200 seconds (the 12-hour Queues delay limit). Defaults come from the `retry_defaults` [setting](settings.md) (falling back to the built-in values when the row is missing or invalid, cached for 30 seconds); destination values override them per field, and the effective `backoff_max_s` is never below `backoff_base_s`. A valid `Retry-After` on 429 replaces the backoff, bounded by policy (see [contract](contract.md)). Avoid quoting a fixed total recovery window: jitter and backend responses change it.

2xx → `delivered`. Retryable failures (408, 429, 5xx, timeout, network) → `retrying`, then `dead` when the attempt that exhausts the budget fails. 3xx and other 4xx → `failed_final`. A retry is a new delayed queue message sent after the attempt is recorded; if that send fails, `msg.retry()` is the fallback. Pause/resume preserves history.

The reconciler runs every minute and re-enqueues up to 500 deliveries per run whose lifecycle was interrupted: `pending` never enqueued for over a minute, `in_flight` with a lease expired for over five minutes (reset to `retrying`), `retrying` overdue by over 15 minutes, and `queued` for over 30 minutes. It sends first, then marks, so a failed mark only causes a duplicate message that the lease absorbs. It also returns paused deliveries of active destinations to `pending` and ends paused deliveries of disabled destinations as `failed_final`.

## Ideas, boundaries, and open work

Delivery is at-least-once, not exactly-once. A backend may have accepted a request before the gateway loses the result (for example, an expired lease); consumers must be idempotent. Throughput tuning requires benchmark evidence.

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/delivery/consumer.ts](../apps/gateway/src/delivery/consumer.ts)
- [apps/gateway/src/delivery/classify.ts](../apps/gateway/src/delivery/classify.ts)
- [apps/gateway/src/delivery/backoff.ts](../apps/gateway/src/delivery/backoff.ts)
- [apps/gateway/src/delivery/dlq.ts](../apps/gateway/src/delivery/dlq.ts)
- [apps/gateway/src/core/db/deliveries.ts](../apps/gateway/src/core/db/deliveries.ts)
- [apps/gateway/src/core/policy.ts](../apps/gateway/src/core/policy.ts)
- [apps/gateway/src/core/enqueue.ts](../apps/gateway/src/core/enqueue.ts)
- [apps/gateway/src/jobs/reconcile.ts](../apps/gateway/src/jobs/reconcile.ts)
- [apps/gateway/wrangler.jsonc](../apps/gateway/wrangler.jsonc)
- [apps/gateway/tests/delivery/consumer.test.ts](../apps/gateway/tests/delivery/consumer.test.ts)
- [apps/gateway/tests/delivery/consumer-limiter.test.ts](../apps/gateway/tests/delivery/consumer-limiter.test.ts)
- [apps/gateway/tests/delivery/classify.test.ts](../apps/gateway/tests/delivery/classify.test.ts)
- [apps/gateway/tests/delivery/backoff.test.ts](../apps/gateway/tests/delivery/backoff.test.ts)
- [apps/gateway/tests/delivery/dlq.test.ts](../apps/gateway/tests/delivery/dlq.test.ts)
- [apps/gateway/tests/jobs/reconcile.test.ts](../apps/gateway/tests/jobs/reconcile.test.ts)
