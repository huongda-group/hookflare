# Projects

[Documentation index](README.md)

## Business rules and current behavior

A project is the organizational boundary for sources, destinations, and events within one deployment. Its generated `prj_…` ID is its only identifier. It has a display name (which need not be unique) and an active/disabled status. Viewers can inspect projects; admins manage them through `config.write`.

Configure a project before its destinations and sources. Disabling a project affects admission through its sources; historical event and delivery records remain available for investigation.

## Design and interaction

Dashboard routes: `/projects` and `/projects/:projectId`. Use names as primary labels, with IDs for disambiguation. Project detail connects configuration and investigation. The New project dialog shows the Name field directly below its title, without a separate section. Create/edit dialogs validate the name and surface API errors; filters must use project IDs.

The Projects list always shows the deployment's full catalog. Opening or editing a project does not change the header selection. Its summary describes the project being viewed; following a Sources, Destinations, or Events link selects that project when entering the scoped view. New endpoints are created from Endpoints in the active project, not from the shared project catalog.

Before the first project exists, the dashboard redirects other signed-in pages to `/projects` and hides unrelated actions. Admins can create a project there; users without `config.write` are prompted to ask an admin and can still sign out. Creating the first project unlocks navigation in the same session. Any project counts, including a disabled one. The [Admin API enforces the same prerequisite](contract.md#design-and-interaction).

API collection `/api/admin/v1/projects` supports GET/POST; `/:id` supports GET/PATCH. Create with `name` and an optional audit `reason`; use the returned `id` to address the project. Do not invent destructive deletion or cascade behavior.

## Ideas, boundaries, and open work

Projects do not provide separate environments or per-project authorization. Those would require explicit new designs.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/admin/routes/projects.ts](../apps/gateway/src/admin/routes/projects.ts)
- [apps/gateway/src/ingress/route.ts](../apps/gateway/src/ingress/route.ts)
- [apps/dashboard/src/pages/ProjectsPage.tsx](../apps/dashboard/src/pages/ProjectsPage.tsx)
- [apps/dashboard/src/pages/ProjectDetailPage.tsx](../apps/dashboard/src/pages/ProjectDetailPage.tsx)
- [apps/gateway/test/admin/projects.test.ts](../apps/gateway/test/admin/projects.test.ts)
- [apps/gateway/test/admin/project-required.test.ts](../apps/gateway/test/admin/project-required.test.ts)
- [apps/dashboard/src/project-onboarding.test.tsx](../apps/dashboard/src/project-onboarding.test.tsx)
