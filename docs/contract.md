# Webhook and admin API contract

[Documentation index](README.md)

## Business rules and current behavior

This is the wire contract for webhook senders, destination backends, and admin API clients. Public ingress is `POST /in/:sourceId`; admin endpoints use `/api/admin/v1`; `/healthz` reports runtime health.

| Ingress result | Meaning |
| --- | --- |
| 202 with `event_id` | Persisted and enqueued, or persisted as paused for a paused destination |
| 200 with `duplicate: true` and `event_id` | Reuses the existing Hookflare event for this source and provider event ID |
| 400 `invalid_request` | The request body could not be read, for example because the client disconnected mid-upload |
| 401 `unauthorized` | Source authentication failed; the body never says why |
| 404 `not_found` | The source ID is malformed or unknown, or the source or its project is disabled |
| 413 `payload_too_large` | Body exceeds the source's limit (checked against `Content-Length` and while reading) |
| 429 `rate_limited` | The per-source rate limit rejected the request |
| 503 `unavailable` | A dependency failed: source lookup or secret decryption, the rate limiter, R2, D1, or the queue. A persisted event may be delivered later |

The limiter is checked before the body is read or authenticated; a limiter outage is a `503`, not a `429`, so the sender retries. A `202` is not backend delivery confirmation. A `503` after persistence does not mean the event was lost: the reconciler enqueues stored work later. If you retry the request, reuse the provider event ID when [the source](sources.md) is configured to extract it, so the retry returns the duplicate response instead of creating a second event.

## Design and interaction

Every delivery is an HTTPS `POST` of the original body bytes with the original `Content-Type`. Outbound signatures use Standard Webhooks v1: HMAC-SHA256, keyed with the base64-decoded `whsec_` secret, over the UTF-8 prefix `<webhook-id>.<webhook-timestamp>.` followed by the original body bytes. Verify against the raw body, not parsed and re-serialized JSON. The generated headers are:

| Header | Meaning |
| --- | --- |
| `webhook-id` | Delivery ID; stable across attempts of that delivery |
| `webhook-timestamp` | Signature timestamp in seconds |
| `webhook-signature` | One `v1,<base64>` signature normally; two space-separated signatures during the rotation grace window, current secret first |
| `X-Webhook-Event-ID` | Event ID; stable across original delivery and replay |
| `User-Agent` | `Hookflare/1` |

The other request headers the sender supplied are forwarded, except credential headers (`authorization`, `cookie`, `x-api-key`, and the source's own auth header), hop-by-hop and `host`/`content-length`, `proxy-*` and `cf-*`, and any sender-supplied `webhook-*`, `x-hookflare-*`, or `x-webhook-event-id` header, so a sender cannot spoof gateway-owned markers. [Test deliveries](destinations.md) add `x-hookflare-test: 1`, use a `tst_…` `webhook-id`, and omit `X-Webhook-Event-ID`.

Replay produces a new `webhook-id`. Choose event-level deduplication when the business operation must not repeat across replay; delivery-level deduplication treats replay as another requested execution. Delivery is at-least-once. The code does not generate separate `X-Webhook-Delivery-ID` or `X-Webhook-Attempt` headers.

A backend 2xx completes delivery. 408, 429, 5xx, timeout, and network errors are retryable within the attempt budget; 3xx and other 4xx are final. Redirects are not followed. On a 429, a `Retry-After` of delta-seconds or an HTTP date replaces the backoff for that retry, clamped to 1 second … `backoff_max_s`, without jitter; it is ignored on other statuses. The first 2,048 bytes of the response body are stored as a snippet; response headers are not stored. See [delivery](delivery.md) for states and backoff.

Admin bodies and responses use the shared Zod/TypeScript contracts below. JSON bodies are capped at 64 KiB (`413 payload_too_large`). Paginated endpoints expose `data` and `next_cursor`; preserve opaque cursors and reset them when filters change. Project, source, and destination lists accept `limit` 1–200; other lists accept 1–100; the default is 50. On protected routes, use a [session cookie](login.md) or [Bearer token](api-tokens.md), not both (`400 ambiguous_credentials`). Missing or invalid credentials return `401 unauthorized`; a missing permission returns `403 {error:"forbidden", required:"<permission>"}`. Cookie-authenticated mutations require a matching `Origin` (`403 bad_origin`). Error bodies use `error`; validation errors are `400 invalid_request` with `issues` of `{path, code, message}`, and an unusable cursor is an `invalid_cursor` issue. Use each feature's page and the actual schema for exact fields, limits, and exceptions.

Until at least one project exists (including a disabled project), authenticated Admin API requests return `409` with `{"error":"project_required"}` except `GET /me` and `GET` or `POST /projects`. Those endpoints enforce their normal authentication and permissions; `GET /me` returns `project_required: true` while there are no projects. The public `/auth` routes, webhook ingress, and `/healthz` are unaffected.

The dashboard passes `project_id` explicitly for project-scoped data. Source and destination details, actions, and test history, event details, deliveries, payloads, and replay, and bulk failure replay accept this optional query parameter. A resource outside the requested project returns `404 not_found`; a bulk replay that names any delivery from another project returns `404 not_found` before applying any replay. For source and destination creation, an optional query scope must match `project_id` in the body (`400` otherwise). Without `project_id`, these routes are unscoped. Project scope does not add a project-level authorization boundary or replace permissions. See [alerts](alerts.md) and [overview](overview.md) for incident scoping.

## Ideas, boundaries, and open work

Generated OpenAPI documentation is not provided.

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/ingress/route.ts](../apps/gateway/src/ingress/route.ts)
- [apps/gateway/src/core/sign.ts](../apps/gateway/src/core/sign.ts)
- [apps/gateway/src/core/outbound.ts](../apps/gateway/src/core/outbound.ts)
- [apps/gateway/src/delivery/classify.ts](../apps/gateway/src/delivery/classify.ts)
- [apps/gateway/src/delivery/consumer.ts](../apps/gateway/src/delivery/consumer.ts)
- [apps/gateway/src/admin/router.ts](../apps/gateway/src/admin/router.ts)
- [apps/gateway/src/admin/http.ts](../apps/gateway/src/admin/http.ts)
- [apps/gateway/src/admin/auth/session.ts](../apps/gateway/src/admin/auth/session.ts)
- [packages/shared/src/admin.ts](../packages/shared/src/admin.ts)
- [apps/gateway/tests/core/sign.test.ts](../apps/gateway/tests/core/sign.test.ts)
- [apps/gateway/tests/ingress/route.test.ts](../apps/gateway/tests/ingress/route.test.ts)
- [apps/gateway/tests/delivery/classify.test.ts](../apps/gateway/tests/delivery/classify.test.ts)
- [apps/gateway/tests/admin/endpoint-scope.test.ts](../apps/gateway/tests/admin/endpoint-scope.test.ts)
