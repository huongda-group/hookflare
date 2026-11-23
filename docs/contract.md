# Webhook and admin API contract

[Documentation index](README.md)

## Business rules and current behavior

This is the wire contract for webhook senders, destination backends, and admin API clients. Public ingress is `POST /in/:sourceId`; admin endpoints use `/api/admin/v1`; `/healthz` reports runtime health.

| Ingress result | Meaning |
| --- | --- |
| 202 with `event_id` | Persisted and enqueued, or persisted as paused for a paused destination |
| 200 with `duplicate: true` and `event_id` | Reuses the existing Hookflare event for this source and provider event ID |
| 400 | Invalid request, such as an interrupted body read |
| 401 | Source authentication failed |
| 404 | Source or related admission configuration is unavailable |
| 413 | Body exceeds the configured limit |
| 429 | Rate limited |
| 503 | Required dependency unavailable, such as storage, queue, or an auth secret that could not be loaded; a persisted event may still be recovered |

A `202` is not backend delivery confirmation. A `503` after persistence does not mean the event was lost: reconciliation can still enqueue it. If you retry the request, reuse the provider event ID when [the source](sources.md) is configured to extract it.

## Design and interaction

Outbound signatures use Standard Webhooks v1: HMAC-SHA256 over the UTF-8 prefix `<delivery-id>.<timestamp>.` followed by the original body bytes. Verify against the raw body, not parsed and re-serialized JSON. The generated headers are:

| Header | Meaning |
| --- | --- |
| `webhook-id` | Delivery ID; stable across attempts of that delivery |
| `webhook-timestamp` | Signature timestamp in seconds |
| `webhook-signature` | One `v1,<base64>` signature normally; two space-separated signatures during the rotation grace window, current secret first |
| `X-Webhook-Event-ID` | Event ID; stable across original delivery and replay |
| `User-Agent` | `Hookflare/1` |

Replay produces a new `webhook-id`. Choose event-level deduplication when the business operation must not repeat across replay; delivery-level deduplication treats replay as another requested execution. Delivery is at-least-once. The code does not generate separate `X-Webhook-Delivery-ID` or `X-Webhook-Attempt` headers.

A backend 2xx completes delivery. 408, 429, 5xx, timeout, and network errors are retryable within budget; 3xx and other 4xx are final. Redirects are not followed. `Retry-After` is considered for 429.

Admin bodies and responses use the shared Zod/TypeScript contracts below. Paginated endpoints expose `data` and `next_cursor`; preserve opaque cursors and reset them when filters change. On protected routes, use a [session cookie](login.md) or [Bearer token](api-tokens.md), not both (`400 ambiguous_credentials`). Cookie-authenticated mutations require a matching `Origin`. Error bodies use `error`, with validation issues where applicable. Use each feature's route document and the actual schema for exact fields, limits, and exceptions.

Until at least one project exists (including a disabled project), authenticated Admin API requests return `409` with `{"error":"project_required"}` except `GET /me` and `GET` or `POST /projects`. These endpoints still enforce their existing authentication and permissions; `GET /me` returns `project_required: true` while there are no projects. The public `/auth` routes, webhook ingress, and `/healthz` are unaffected.

The dashboard passes `project_id` explicitly for project-scoped data. Source and destination details, actions, and test history, event details, deliveries, payloads, and replay, and bulk failure replay accept this optional query parameter. A resource outside the requested project returns `404 not_found`; a mixed-project replay request is rejected before applying any replay. For source and destination creation, an optional query scope must match `project_id` in the body (`400` otherwise). Omitting scope preserves the unscoped API contract. Project scope does not add a project-level authorization boundary or replace existing permissions. See [alerts](alerts.md) and [overview](overview.md) for incident scoping.

## Ideas, boundaries, and open work

Generated OpenAPI documentation is not currently provided.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/core/sign.ts](../apps/gateway/src/core/sign.ts)
- [apps/gateway/src/delivery/consumer.ts](../apps/gateway/src/delivery/consumer.ts)
- [apps/gateway/src/ingress/route.ts](../apps/gateway/src/ingress/route.ts)
- [apps/gateway/src/admin/router.ts](../apps/gateway/src/admin/router.ts)
- [apps/gateway/src/admin/auth/session.ts](../apps/gateway/src/admin/auth/session.ts)
- [packages/shared/src/admin.ts](../packages/shared/src/admin.ts)
- [apps/gateway/test/core/sign.test.ts](../apps/gateway/test/core/sign.test.ts)
