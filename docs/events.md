# Events and investigation

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

The Events list is the durable investigation entry point. An event describes an accepted payload; delivery rows describe attempts to send it. The detail view must show delivery histories separately, including original and replay deliveries, attempts, statuses, timings, and errors.

Metadata is readable with `events.read`. Raw payload requires `payload.read`; sensitive headers are redacted. A missing payload is a meaningful unavailable state and blocks replay rather than looking like an empty body.

## Design and interaction

UI routes: `/events` and `/events/:eventId`. API: GET `/api/admin/v1/events`, `/:id`, `/:id/deliveries`, and `/:id/payload`. Filters and cursor pagination must remain consistent when navigating back or changing the query.

Event detail shows the actual source, selected delivery destination/outcome, newest-first independent delivery histories, and a response inspector. An attempt is selected by delivery ID and attempt ID, so replay attempts numbered alike do not collide; polling keeps valid selection and event navigation resets it. Zero deliveries/attempts have explicit states. The inspector identifies the selected delivery and attempt; Response renders only the stored **snippet** as text, including HTML-like content, and does not invent a full body or response headers. Request headers are the accepted event's redacted headers, not reconstructed outbound headers.

Show payload is an explicit `payload.read`-gated request; large bodies remain bounded. Viewer accounts cannot replay or retrieve payload. A confirmed missing payload disables replay. Permission-aware Replay uses the existing dialog and validates a reason; creating a new delivery is not successful backend delivery, and the original history remains intact. Status summaries distinguish dead, failed-final, retrying, paused, pending, queued, in-flight, and delivered without asserting an unknown historical retry policy.

## Ideas, boundaries, and open work

Archived data is browsed/downloaded separately; the hot Events search does not search archives. Payload transformation and realtime streaming are outside current scope.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/admin/routes/events.ts](../apps/gateway/src/admin/routes/events.ts)
- [apps/dashboard/src/pages/EventsPage.tsx](../apps/dashboard/src/pages/EventsPage.tsx)
- [apps/dashboard/src/pages/EventDetailPage.tsx](../apps/dashboard/src/pages/EventDetailPage.tsx)
- [apps/dashboard/src/components/PayloadPanel.tsx](../apps/dashboard/src/components/PayloadPanel.tsx)
- [apps/gateway/test/admin/events.test.ts](../apps/gateway/test/admin/events.test.ts)
