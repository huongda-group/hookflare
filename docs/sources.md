# Sources and webhook ingress

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

A source receives `POST /in/:sourceId` and routes to one destination in its project. Authentication supports `none`, HMAC, or token. Verify the raw body before parsing JSON; provider event IDs may come from a header or JSON path. With a provider event ID, duplicates are scoped to the source and return the existing event rather than creating another logical event.

Ingress enforces source/project/destination state, rate limits, and body-size limits. Payloads up to 64 KiB are inline; larger payloads use R2. D1 persistence and enqueue must succeed before 202, except a paused destination stores a paused delivery without enqueue. Queue failure after persistence returns 503 and is later recoverable by reconciliation.

## Design and interaction

Endpoints → Sources supports configuration, detail, and secret rotation. API prefix `/api/admin/v1/sources` provides GET/POST collection, GET/PATCH `/:id`, and POST `/:id/rotate-secret`. Read metadata with `events.read`; mutate with `config.write`.

Expose source URL, auth type, destination, provider-ID extraction, and body limit clearly. Credential-bearing headers are redacted and excluded from forwarding. Rotation must communicate the grace window and show a new secret only once. See [contract](contract.md) for response meanings.

## Ideas, boundaries, and open work

Provider-specific presets and timestamp-tolerance protocols remain backlog work. The generic HMAC verifier is not proof of compatibility with every provider signature scheme.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/ingress/route.ts](../apps/gateway/src/ingress/route.ts)
- [apps/gateway/src/ingress/verify.ts](../apps/gateway/src/ingress/verify.ts)
- [apps/gateway/src/ingress/event-id.ts](../apps/gateway/src/ingress/event-id.ts)
- [apps/gateway/src/admin/routes/sources.ts](../apps/gateway/src/admin/routes/sources.ts)
- [apps/dashboard/src/pages/endpoints/SourceDetailPage.tsx](../apps/dashboard/src/pages/endpoints/SourceDetailPage.tsx)
- [apps/gateway/test/ingress/route.test.ts](../apps/gateway/test/ingress/route.test.ts)

