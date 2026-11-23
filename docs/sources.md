# Sources and webhook ingress

[Documentation index](README.md)

## Business rules and current behavior

A source receives `POST /in/:sourceId` and routes every accepted event to one destination in its project. Ingress handles a request in this order: look up the source, check that the source and its project are active, apply the per-source rate limit, read the body under the size cap, verify authentication, extract the provider event ID, check for a duplicate, store a large payload in R2, store the event and its initial delivery in D1, then enqueue. See the [wire contract](contract.md) for each response.

Authentication supports `none`, HMAC, or a shared token:

- **HMAC:** a signature header, algorithm SHA-1, SHA-256, or SHA-512, `hex` or `base64` encoding, and an optional prefix (such as `sha256=`) that must be present and is stripped before decoding. The HMAC is computed over the raw body bytes.
- **Token:** a header or query parameter that must equal the secret.

Comparisons are constant-time. A failed check always answers a bare `401`; the failure reason is only logged. Secrets are 16–512 characters when supplied; otherwise the gateway generates one (32 random bytes, base64url) and returns it only in the create or rotate response. During a rotation grace window the previous secret is also accepted.

Provider event IDs come from a header or a JSON path (`$` followed by `.key` or `[index]` segments, such as `$.data.object.id`), and are read only after verification. A string or finite number up to 256 characters is used; anything else (missing value, invalid UTF-8 or JSON) means no provider ID, and the request is accepted without deduplication. With a provider event ID, duplicates are scoped to the source and return the existing event rather than creating another logical event, including when two requests race.

The checked-in rate limit is 100 requests per 10 seconds per source. The body limit defaults to 1 MiB and is configurable per source up to 10 MiB. Payloads up to 64 KiB are stored inline; larger payloads are written to R2 before D1 references them. Ingress stores request headers for investigation and forwarding: `authorization`, `cookie`, `x-api-key`, and the source's own signature/token header are stored redacted and never forwarded; hop-by-hop, `host`, `content-length`, `proxy-*`, and `cf-*` headers are neither stored nor forwarded.

Ingress caches each source lookup, including "not found", for 30 seconds per isolate, so admin changes (status, auth, destination) take effect within that window. A disabled source or project answers `404`. A paused destination accepts events and holds their deliveries as `paused`; a disabled destination also accepts events, whose deliveries then end as `failed_final` without an attempt (see [delivery](delivery.md)).

## Design and interaction

Endpoints → Sources supports configuration, detail, and secret rotation. API prefix `/api/admin/v1/sources` provides GET/POST collection, GET/PATCH `/:id`, and POST `/:id/rotate-secret`. Read metadata with `events.read`; mutate with `config.write`. Responses carry `ingress_url` (from `PUBLIC_BASE_URL`, else the request origin) and secret fingerprints, never the stored secret.

The project and destination must exist and the destination must belong to the source's project; otherwise create or PATCH returns `422 invalid_reference` with the offending `field`. `auth_type` is fixed at creation; a PATCHed `auth_config` must match it, and provider-ID settings are validated against the merged row (`400 invalid_request`). Rotation takes `grace_hours` 0–168 (default 24; 0 revokes the current secret immediately) and an optional custom `secret`; it returns `409 no_secret` for `none` sources and `409 conflict` when a concurrent rotation won. Changes write `source.created`, `source.updated`, and `source.secret_rotated` [audit](audit.md) rows; the rotation entry records the new fingerprint, never the secret.

The Sources tab lists and creates sources in the active project. The destination picker in the source form only offers destinations from that project. Source detail shows the ingress URL, project, target destination, a link to this source's events, body limit, auth configuration, provider-ID extraction, and current/previous secret fingerprints with the grace expiry. Edit, Rotate secret (not for `none`), and Disable/Enable require `config.write`. A generated secret is shown once with copy and an "I have stored this secret" confirmation; the rotation dialog states the grace window and warns that 0 revokes immediately.

## Ideas, boundaries, and open work

Provider-specific presets and timestamp-tolerance protocols remain backlog work. The generic HMAC verifier is not proof of compatibility with every provider signature scheme.

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/ingress/route.ts](../apps/gateway/src/ingress/route.ts)
- [apps/gateway/src/ingress/verify.ts](../apps/gateway/src/ingress/verify.ts)
- [apps/gateway/src/ingress/event-id.ts](../apps/gateway/src/ingress/event-id.ts)
- [apps/gateway/src/ingress/body.ts](../apps/gateway/src/ingress/body.ts)
- [apps/gateway/src/core/headers.ts](../apps/gateway/src/core/headers.ts)
- [apps/gateway/src/core/source-cache.ts](../apps/gateway/src/core/source-cache.ts)
- [apps/gateway/wrangler.jsonc](../apps/gateway/wrangler.jsonc)
- [packages/shared/src/admin.ts](../packages/shared/src/admin.ts)
- [packages/shared/src/json-path.ts](../packages/shared/src/json-path.ts)
- [apps/gateway/src/admin/routes/sources.ts](../apps/gateway/src/admin/routes/sources.ts)
- [apps/dashboard/src/pages/endpoints/SourceDetailPage.tsx](../apps/dashboard/src/pages/endpoints/SourceDetailPage.tsx)
- [apps/dashboard/src/components/SourceFormDialog.tsx](../apps/dashboard/src/components/SourceFormDialog.tsx)
- [apps/gateway/tests/ingress/route.test.ts](../apps/gateway/tests/ingress/route.test.ts)
- [apps/gateway/tests/ingress/verify.test.ts](../apps/gateway/tests/ingress/verify.test.ts)
- [apps/gateway/tests/ingress/event-id.test.ts](../apps/gateway/tests/ingress/event-id.test.ts)
- [apps/gateway/tests/admin/sources.test.ts](../apps/gateway/tests/admin/sources.test.ts)
- [apps/gateway/tests/admin/rotation.test.ts](../apps/gateway/tests/admin/rotation.test.ts)
- [apps/dashboard/tests/pages/endpoints/SourceDetailPage.test.tsx](../apps/dashboard/tests/pages/endpoints/SourceDetailPage.test.tsx)
