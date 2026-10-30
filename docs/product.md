# Product and business model

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

Hookflare receives inbound webhooks, persists them, and delivers them to a configured backend with retry, investigation, and recovery. The operator should be able to accept events while a backend is unavailable and understand what happened afterward.

One deployment is one environment. A project groups sources and destinations. A source selects one destination; an event is an accepted input; a delivery is one delivery lifecycle; an attempt is one outbound HTTP call. Replay creates another delivery for the same event.

Global roles are viewer, operator, and admin. They describe repository permissions, not research personas. See [users](users.md) for the permission matrix.

## Design and interaction

The main journey is [setup](login.md) → create a [project](projects.md) → configure a [destination](destinations.md) and [source](sources.md) → receive an [event](events.md) → inspect [delivery](delivery.md) → [recover failures](replay.md). Routine work starts at [overview](overview.md).

Reliability and auditability take priority. Keep event, delivery, and attempt distinct in labels. Display names with IDs available for disambiguation. Describe pending work honestly; acceptance into a queue is not successful backend delivery.

## Ideas, boundaries, and open work

Payload transformation, fan-out, workflow editors, SaaS billing, and realtime WebSocket dashboards are out of scope. Provider presets, per-project permissions, and restoring archived events are backlog ideas, not shipped capabilities. See [roadmap](roadmap.md).

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [README.md](../README.md)
- [apps/gateway/src/core/db/schema.ts](../apps/gateway/src/core/db/schema.ts)
- [apps/dashboard/src/components/AppNavigation.tsx](../apps/dashboard/src/components/AppNavigation.tsx)

