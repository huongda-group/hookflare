# Failures, replay, and test delivery

[Documentation index](README.md)

## Business rules and current behavior

Operators recover failed work by creating a new delivery for an existing event. Replay requires a reason, preserves old deliveries/attempts, checks payload and destination eligibility, and records the new delivery ID in audit history. Missing payload returns a conflict rather than creating unrecoverable work.

Bulk replay is bounded at 100 selected deliveries. A bulk response can contain distinct outcomes; the UI must report what happened for each selection. A created replay may still await enqueue and is never immediately described as delivered.

## Design and interaction

UI: `/failures` and the replay dialog on event detail. API: GET `/api/admin/v1/failures`, POST `/failures/replay`, and POST `/events/:id/replay`. Use `deliveries.replay` for recovery. Refresh affected event/failure/overview data after mutation.

Failures and replay in the dashboard use the active project. Switching projects clears selected deliveries; a submitted replay keeps its original scope. If an API request includes `project_id`, any found delivery belonging to a different project rejects the entire bulk request without creating or queueing a replay.

Explain whether selection covers the current page and reset invalid selections when filters change. Show success, skipped/conflict, and enqueue-pending results honestly. Test delivery is a separate synchronous destination operation with recorded test history, not a fabricated incoming event.

## Ideas, boundaries, and open work

Archive replay/restore is not implemented. Replaying does not erase the initial failure or guarantee that the backend business action will be repeated; backend idempotency rules still apply.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/admin/replay.ts](../apps/gateway/src/admin/replay.ts)
- [apps/gateway/src/admin/routes/failures.ts](../apps/gateway/src/admin/routes/failures.ts)
- [apps/gateway/src/admin/routes/events.ts](../apps/gateway/src/admin/routes/events.ts)
- [apps/dashboard/src/components/ReplayDialog.tsx](../apps/dashboard/src/components/ReplayDialog.tsx)
- [apps/dashboard/src/pages/FailuresPage.tsx](../apps/dashboard/src/pages/FailuresPage.tsx)
- [apps/gateway/tests/admin/replay.test.ts](../apps/gateway/tests/admin/replay.test.ts)
