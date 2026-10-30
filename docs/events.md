# Events and investigation

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

The Events list is the durable investigation entry point. An event describes an accepted payload; delivery rows describe attempts to send it. The detail view must show delivery histories separately, including original and replay deliveries, attempts, statuses, timings, and errors.

Metadata is readable with `events.read`. Raw payload requires `payload.read`; sensitive headers are redacted. A missing payload is a meaningful unavailable state and blocks replay rather than looking like an empty body.

## Design and interaction

UI routes: `/events` and `/events/:eventId`. API: GET `/api/admin/v1/events`, `/:id`, `/:id/deliveries`, and `/:id/payload`. Filters and cursor pagination must remain consistent when navigating back or changing the query.

Use explicit Show payload before fetching/rendering payload data. Keep large bodies bounded in the UI; display raw/JSON views without treating untrusted data as HTML. Distinguish loading, no results, request failure, and unavailable payload. Place delivery status and recovery actions ahead of raw payload detail.

## Ideas, boundaries, and open work

Archived data is browsed/downloaded separately; the hot Events search does not search archives. Payload transformation and realtime streaming are outside current scope.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/admin/routes/events.ts](../apps/gateway/src/admin/routes/events.ts)
- [apps/dashboard/src/pages/EventsPage.tsx](../apps/dashboard/src/pages/EventsPage.tsx)
- [apps/dashboard/src/pages/EventDetailPage.tsx](../apps/dashboard/src/pages/EventDetailPage.tsx)
- [apps/dashboard/src/components/PayloadPanel.tsx](../apps/dashboard/src/components/PayloadPanel.tsx)
- [apps/gateway/test/admin/events.test.ts](../apps/gateway/test/admin/events.test.ts)

