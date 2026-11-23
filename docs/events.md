# Events and investigation

[Documentation index](README.md)

## Business rules and current behavior

The Events list is the durable investigation entry point. An event describes an accepted payload; delivery rows describe attempts to send it. The detail view must show delivery histories separately, including original and replay deliveries, attempts, statuses, timings, and errors.

Metadata is readable with `events.read`. Raw payload requires `payload.read`; stored request headers are already redacted at ingress (see [sources](sources.md)). Every payload view writes an `event.payload_viewed` [audit](audit.md) row; if that row cannot be written, the payload is not returned (`503`). A missing payload (`404 payload_missing`, the R2 object is missing) is a meaningful unavailable state and blocks replay rather than looking like an empty body.

## Design and interaction

UI routes: `/events` and `/events/:eventId`. API: GET `/api/admin/v1/events`, `/:id`, `/:id/deliveries`, and `/:id/payload`. The list filters on `project_id`, `source_id`, `destination_id`, repeatable `status`, `http_status`, `provider_event_id` (requires `source_id`), and a `from`/`to` range on received time; delivery filters match an event when any of its deliveries matches, and each event appears once. Results are newest first with cursor pagination, and each row carries its newest delivery. Filters and cursor pagination must remain consistent when navigating back or changing the query.

Event detail returns the event metadata, its stored headers, and every delivery with its attempts; the payload is only served by `/:id/payload`, as an attachment with its original content type, `nosniff`, and `no-store`.

The dashboard's list, source and destination filters, and event detail (including payload) use the active project. Switching projects clears resource and provider-ID filters and retains independent time, status, and HTTP-status filters. A detail ID outside its explicit project scope is not found. The search box opens an `evt_…` ID directly; searching by provider event ID first requires choosing a source.

Event detail shows the actual source, selected delivery destination/outcome, newest-first independent delivery histories, and a response inspector. It refreshes every 15 seconds while any delivery is active. An attempt is selected by delivery ID and attempt ID, so replay attempts numbered alike do not collide; polling keeps a valid selection and event navigation resets it. Zero deliveries/attempts have explicit states. The inspector identifies the selected delivery and attempt; Response renders only the stored **snippet** (up to 2,048 bytes) as text, including HTML-like content, and does not invent a full body or response headers. Request headers are the accepted event's redacted headers, not reconstructed outbound headers.

Show payload is an explicit `payload.read`-gated request. JSON payloads render as a tree or raw text, and trees above 256 KB open collapsed; non-UTF-8 bodies are offered as a download. Viewer accounts cannot replay or retrieve payload. A confirmed missing payload disables replay. Permission-aware Replay uses the shared [replay dialog](replay.md) and validates a reason; creating a new delivery is not successful backend delivery, and the original history remains intact. Status summaries distinguish dead, failed-final, retrying, paused, pending, queued, in-flight, and delivered without asserting the retry policy in force at the time.

## Ideas, boundaries, and open work

Archived data is browsed/downloaded separately; the hot Events search does not search archives. Payload transformation and realtime streaming are outside current scope.

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/admin/routes/events.ts](../apps/gateway/src/admin/routes/events.ts)
- [apps/gateway/src/core/db/events.ts](../apps/gateway/src/core/db/events.ts)
- [apps/dashboard/src/pages/EventsPage.tsx](../apps/dashboard/src/pages/EventsPage.tsx)
- [apps/dashboard/src/pages/EventDetailPage.tsx](../apps/dashboard/src/pages/EventDetailPage.tsx)
- [apps/dashboard/src/components/EventFilters.tsx](../apps/dashboard/src/components/EventFilters.tsx)
- [apps/dashboard/src/components/EventInspector.tsx](../apps/dashboard/src/components/EventInspector.tsx)
- [apps/dashboard/src/components/PayloadPanel.tsx](../apps/dashboard/src/components/PayloadPanel.tsx)
- [apps/gateway/tests/admin/events.test.ts](../apps/gateway/tests/admin/events.test.ts)
- [apps/gateway/tests/admin/payload.test.ts](../apps/gateway/tests/admin/payload.test.ts)
- [apps/dashboard/tests/pages/EventsPage.test.tsx](../apps/dashboard/tests/pages/EventsPage.test.tsx)
- [apps/dashboard/tests/pages/EventDetailPage.test.tsx](../apps/dashboard/tests/pages/EventDetailPage.test.tsx)
- [apps/dashboard/tests/components/EventInspector.test.tsx](../apps/dashboard/tests/components/EventInspector.test.tsx)
