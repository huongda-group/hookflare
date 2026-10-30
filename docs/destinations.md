# Destinations and backend protection

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

A destination is an HTTPS backend endpoint belonging to a project. Admins configure URL, timeout, retry overrides, concurrency, rate limits, and signing secrets. Operators can pause/resume and send test deliveries.

Paused destinations hold work without consuming attempts. Disabled destinations do not accept ordinary delivery. Outbound requests use SSRF checks, credential-header filtering, and manual redirects. DNS/network failures and blocked addresses have distinct handling; see [delivery](delivery.md).

## Design and interaction

Endpoints → Destinations provides list/detail, policy editing, reason-confirmed pause/resume, test delivery, and secret rotation. API prefix `/api/admin/v1/destinations` includes list/create/detail/update, `/stats`, `/:id/pause`, `/:id/resume`, `/:id/test`, `/:id/tests`, and `/:id/rotate-secret`.

A destination policy field overrides the corresponding global default; unset fields inherit. Explain inherited values rather than displaying a blank as zero. During outbound secret rotation, both signatures can be sent in the grace window. A test result is synchronous and separate from an event replay.

## Ideas, boundaries, and open work

A destination is not a fan-out workflow. Rate/concurrency limits protect an individual backend; they do not establish measured system throughput.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/admin/routes/destinations.ts](../apps/gateway/src/admin/routes/destinations.ts)
- [apps/gateway/src/core/ssrf.ts](../apps/gateway/src/core/ssrf.ts)
- [apps/gateway/src/core/sign.ts](../apps/gateway/src/core/sign.ts)
- [apps/gateway/src/delivery/limiter.ts](../apps/gateway/src/delivery/limiter.ts)
- [apps/dashboard/src/pages/endpoints/DestinationDetailPage.tsx](../apps/dashboard/src/pages/endpoints/DestinationDetailPage.tsx)
- [apps/gateway/test/admin/destinations.test.ts](../apps/gateway/test/admin/destinations.test.ts)

