# Projects

[Documentation index](README.md)

## Business rules and current behavior

A project is the organizational boundary for sources, destinations, and events within one deployment. Its generated `prj_…` ID is its only identifier. It has a display name (trimmed, 1–100 characters, not necessarily unique) and an `active`/`disabled` status. Viewers can inspect projects through `events.read`; admins create and edit them through `config.write`.

Projects have no slug or other user-chosen key. The generated ID is stable and is what routes, filters, `project_id` query scopes, and resource references use, so renaming a project never changes a URL or a reference.

Configure a project before its destinations and sources. Disabling a project makes ingress for all of its sources answer `404`; events already accepted keep their deliveries, retries, and replays, and their records remain available for investigation. Projects cannot be deleted.

## Design and interaction

Dashboard routes: `/projects` and `/projects/:projectId`. Use names as primary labels, with IDs for disambiguation; the header project selector shows `name (id)` when two projects share a name. The New project dialog shows the Name field directly below its title, without a separate section. Create/edit dialogs validate the name and surface API errors; filters must use project IDs.

The Projects list always shows the deployment's full catalog. Opening or editing a project does not change the header selection. Project detail shows status and ID, Edit and Disable/Enable actions (confirmed, with an optional reason) for `config.write`, an empty-state prompt to add a source and destination, and the project's overview statistics. Following its Sources, Destinations, or Events link selects that project when entering the scoped view. New sources and destinations are created from Endpoints in the active project, not from the shared project catalog.

Before the first project exists, the dashboard redirects other signed-in pages to `/projects` and hides navigation and unrelated actions. Admins can create a project there; users without `config.write` are prompted to ask an admin and can sign out. Creating the first project unlocks navigation in the same session. Any project counts, including a disabled one. The [Admin API enforces the same prerequisite](contract.md#design-and-interaction).

API collection `/api/admin/v1/projects` supports GET (cursor-paginated, `limit` 1–200, default 50) and POST; `/:id` supports GET and PATCH (`name`, `status`). Create with `name` and an optional audit `reason`; the response (`201`) carries the generated `id` used to address the project. Unknown IDs return `404 not_found`. Creation and updates write `project.created`/`project.updated` [audit](audit.md) rows in the same batch.

## Ideas, boundaries, and open work

Projects do not provide separate environments or per-project authorization. Those would require explicit new designs. Deletion and cascade behavior are not implemented.

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/admin/routes/projects.ts](../apps/gateway/src/admin/routes/projects.ts)
- [apps/gateway/src/admin/router.ts](../apps/gateway/src/admin/router.ts)
- [apps/gateway/src/ingress/route.ts](../apps/gateway/src/ingress/route.ts)
- [apps/dashboard/src/pages/ProjectsPage.tsx](../apps/dashboard/src/pages/ProjectsPage.tsx)
- [apps/dashboard/src/pages/ProjectDetailPage.tsx](../apps/dashboard/src/pages/ProjectDetailPage.tsx)
- [apps/dashboard/src/components/ProjectFormDialog.tsx](../apps/dashboard/src/components/ProjectFormDialog.tsx)
- [apps/dashboard/src/lib/project-selection.tsx](../apps/dashboard/src/lib/project-selection.tsx)
- [apps/gateway/tests/admin/projects.test.ts](../apps/gateway/tests/admin/projects.test.ts)
- [apps/gateway/tests/admin/project-required.test.ts](../apps/gateway/tests/admin/project-required.test.ts)
- [apps/dashboard/tests/project-onboarding.test.tsx](../apps/dashboard/tests/project-onboarding.test.tsx)
- [apps/dashboard/tests/pages/ProjectDetailPage.test.tsx](../apps/dashboard/tests/pages/ProjectDetailPage.test.tsx)
