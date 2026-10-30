# Projects

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

A project is the organizational boundary for sources, destinations, and events within one deployment. It has a name, slug, and active/disabled status. Viewers can inspect projects; admins manage them through `config.write`.

Configure a project before its destinations and sources. Disabling a project affects admission through its sources; historical event and delivery records remain available for investigation.

## Design and interaction

Dashboard routes: `/projects` and `/projects/:projectId`. Use names as primary labels, with IDs for disambiguation. Project detail connects configuration and investigation. Create/edit dialogs validate fields and surface API conflicts; filters must use project IDs.

API collection `/api/admin/v1/projects` supports GET/POST; `/:id` supports GET/PATCH. Do not invent destructive deletion or cascade behavior.

## Ideas, boundaries, and open work

Projects do not provide separate environments or per-project authorization. Those would require explicit new designs.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/admin/routes/projects.ts](../apps/gateway/src/admin/routes/projects.ts)
- [apps/gateway/src/ingress/route.ts](../apps/gateway/src/ingress/route.ts)
- [apps/dashboard/src/pages/ProjectsPage.tsx](../apps/dashboard/src/pages/ProjectsPage.tsx)
- [apps/dashboard/src/pages/ProjectDetailPage.tsx](../apps/dashboard/src/pages/ProjectDetailPage.tsx)
- [apps/gateway/test/admin/projects.test.ts](../apps/gateway/test/admin/projects.test.ts)

