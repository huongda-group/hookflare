# Webhook and admin API contract

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

This document describes the integration contract, not a commercial agreement. Public ingress is `POST /in/:sourceId`; admin endpoints use `/api/admin/v1`; `/healthz` reports runtime health.

| Ingress result | Meaning |
| --- | --- |
| 202 | Persisted and enqueued, or persisted as paused for a paused destination |
| 200 with `duplicate: true` | Existing provider event ID for this source |
| 400 | Invalid request, such as an interrupted body read |
| 401 | Source authentication failed |
| 404 | Source or related admission configuration is unavailable |
| 413 | Body exceeds the configured limit |
| 429 | Rate limited |
| 503 | Required persistence/queue dependency failed; a persisted event may still be recovered |

A 202 is not backend delivery confirmation. Clients must handle retries and duplicate events.

## Design and interaction

Outbound signatures use Standard Webhooks v1: HMAC-SHA256 over the delivery ID, timestamp in seconds, and original body bytes. The actual generated headers are:

| Header | Meaning |
| --- | --- |
| `webhook-id` | Delivery ID; stable across attempts of that delivery |
| `webhook-timestamp` | Signature timestamp in seconds |
| `webhook-signature` | One or more `v1,` signatures during secret rotation |
| `X-Webhook-Event-ID` | Event ID; stable across original delivery and replay |
| `User-Agent` | `Hookflare/1` |

Replay produces a new `webhook-id`. Choose event-level deduplication when the business operation must not repeat across replay; delivery-level deduplication treats replay as another requested execution. Delivery is at-least-once. The code does not generate separate `X-Webhook-Delivery-ID` or `X-Webhook-Attempt` headers.

A backend 2xx completes delivery. 408, 429, 5xx, timeout, and network errors are retryable within budget; 3xx and other 4xx are final. Redirects are not followed. `Retry-After` is considered for 429.

Admin bodies and responses use the shared Zod/TypeScript contracts below. Paginated endpoints expose `data` and `next_cursor`; preserve opaque cursors and reset them when filters change. Auth accepts a session cookie or Bearer token, not both. Error bodies use `error`, with validation issues where applicable. Use each feature's route document and the actual schema for exact fields, limits, and exceptions.

## Ideas, boundaries, and open work

The original system specification contained proposed headers and API paths that differ from the implementation. This current contract follows the source. Generated OpenAPI documentation is not currently provided.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/core/sign.ts](../apps/gateway/src/core/sign.ts)
- [apps/gateway/src/delivery/consumer.ts](../apps/gateway/src/delivery/consumer.ts)
- [apps/gateway/src/ingress/route.ts](../apps/gateway/src/ingress/route.ts)
- [apps/gateway/src/admin/router.ts](../apps/gateway/src/admin/router.ts)
- [packages/shared/src/admin.ts](../packages/shared/src/admin.ts)
- [apps/gateway/test/core/sign.test.ts](../apps/gateway/test/core/sign.test.ts)

