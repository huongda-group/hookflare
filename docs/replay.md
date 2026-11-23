# Failures, replay, and test delivery

[Documentation index](README.md)

## Business rules and current behavior

Operators recover failed work by creating a new delivery (`kind=replay`, attempt count 0, `created_by` set to the actor) for an existing event. Replay requires a reason (1–500 characters), preserves old deliveries/attempts, checks destination and payload eligibility, and records the new delivery ID in audit history. A replay to a paused destination is created as `paused` and released on Resume; any other replay is enqueued immediately. Replay also clears the event's archive mark, so purge skips it and the event is archived again later (see [archives](archives.md)).

Eligibility is checked per item in this order, and the first failure names the skip reason:

- `destination_disabled`: the destination is disabled.
- `payload_missing`: the event's R2 payload object is missing. An R2 error while checking is an infrastructure error (`503`), never a per-item skip.
- `replay_in_progress`: a non-terminal replay already exists for the same event and destination, or the same pair appears earlier in the same bulk request.

At most one non-terminal replay exists per event and destination. The insert itself checks this, so of two concurrent replays of the same failure only one creates a delivery; the other reports `replay_in_progress` and is neither enqueued nor listed as replayed. The `delivery.replayed` [audit](audit.md) row is written in the same batch only when at least one replay was created; it lists every created pair (source and new delivery IDs) and every skip.

Event replay (`POST /events/:id/replay`) targets the event's initial delivery destination, whatever that delivery's status. Replaying a delivered event is intentional: it re-sends the event when a backend lost or must reprocess it, and the reason recorded in the audit explains why. It returns `201 {delivery_id, status, enqueued}` or `409` with the skip reason as `error`. Bulk replay (`POST /failures/replay`) takes 1–100 `delivery_ids` (duplicates removed) and returns `200 {replayed, skipped}`, where each replayed entry carries `delivery_id`, `new_delivery_id`, the new delivery's `status` (`paused` when held by a paused destination), and `enqueued`; besides the reasons above, it skips `not_found` IDs and deliveries that are not `failed_final` or `dead` (`not_failed`). A bulk response can contain distinct outcomes; the UI must report what happened for each selection. A created replay whose enqueue failed stays `pending` with `enqueued: false` until the reconciler sends it, and is never described as delivered.

## Design and interaction

UI: `/failures` and the replay dialog on event detail. API: GET `/api/admin/v1/failures`, POST `/failures/replay`, and POST `/events/:id/replay`. Use `deliveries.replay` for recovery; the Failures list needs only `events.read`. Refresh affected event/failure/overview data after mutation.

The Failures list returns `failed_final` and `dead` deliveries ordered by completion time, newest first, filterable by `status`, `project_id`, `destination_id`, and a `from`/`to` range on completion time. `unresolved` (default `true`) hides a failure once a later replay of the same event and destination has been delivered; each row carries its `latest_replay` when one is newer than the failure. The dashboard shows Dead and Failed-final tabs (Dead first), a destination filter, the "Unresolved only" toggle, and a time range.

Failures and replay in the dashboard use the active project. Switching projects clears selected deliveries and the destination filter; a submitted replay keeps its original scope. If an API request includes `project_id`, any found delivery belonging to a different project rejects the entire bulk request with `404 not_found` without creating or queueing a replay.

Selection covers only loaded rows, up to 100 per bulk replay; the page states this, and invalid selections reset when filters change. The replay dialog requires a reason and groups results as Created, Awaiting enqueue (explaining a paused destination or a pending reconciler send), and Skipped with each reason. Test delivery is a separate synchronous [destination operation](destinations.md) with recorded test history, not a fabricated incoming event.

## Ideas, boundaries, and open work

Archive replay/restore is not implemented. Replaying does not erase the initial failure or guarantee that the backend business action will be repeated; backend idempotency rules apply.

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/admin/replay.ts](../apps/gateway/src/admin/replay.ts)
- [apps/gateway/src/core/db/replays.ts](../apps/gateway/src/core/db/replays.ts)
- [apps/gateway/src/admin/routes/failures.ts](../apps/gateway/src/admin/routes/failures.ts)
- [apps/gateway/src/admin/routes/events.ts](../apps/gateway/src/admin/routes/events.ts)
- [apps/dashboard/src/components/ReplayDialog.tsx](../apps/dashboard/src/components/ReplayDialog.tsx)
- [apps/dashboard/src/pages/FailuresPage.tsx](../apps/dashboard/src/pages/FailuresPage.tsx)
- [apps/gateway/tests/admin/replay.test.ts](../apps/gateway/tests/admin/replay.test.ts)
- [apps/gateway/tests/admin/failures.test.ts](../apps/gateway/tests/admin/failures.test.ts)
- [apps/dashboard/tests/pages/FailuresPage.test.tsx](../apps/dashboard/tests/pages/FailuresPage.test.tsx)
