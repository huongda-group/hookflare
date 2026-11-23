# Dashboard project switcher

Status: implemented. See [Dashboard design system](../../dashboard.md) for current behavior.

## Intent and scope

Make the active project explicit and consistent across the dashboard without turning projects into separate deployments or permission boundaries. Remove the “Hookflare instance / Current deployment” cards from the desktop sidebar and mobile drawer. Put the project picker immediately **to the left of** the page breadcrumb/title in the shared header, including Overview.

```text
[ Project A ▾ ]  Overview                          Account
[ Project A ▾ ]  Events                            Account
```

| Scope              | Views and behavior                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Active project     | Overview, Endpoints (sources and destinations), Events, Failures, and project alert incidents. Related detail views, filters, counts, actions, and forms use the same project.             |
| Deployment         | Users, API tokens, account, backups, storage and retention, retry defaults, alert rules/channels, archive batches, and the combined audit trail. Existing permissions and behavior remain. |
| Project management | The project picker and Projects management can see the deployment-wide project catalog. The Projects list and its management detail are independent of the active project.                 |

Shared alerts (for example, storage pressure and stale backups) remain visible in a separately labeled deployment section on Alerts. They are excluded from project incident counts and project Overview. Archive downloads and the audit trail are labeled deployment-wide, not presented as project-filtered data. There is no “All projects” option for project views.

## Approaches

1. **One shared project selection, with server-side scoping for project data (chosen).** Reuse existing project IDs, server filters, and permissions. Add checks for project-scoped details and actions. Deployment views remain independent of the picker.
2. **Keep page-level filters or filter API results in the browser.** Less initial work, but filters can disagree; pagination, counts, and actions can still include the wrong project's data. Rejected.
3. **Give each project its own settings, jobs, and permissions.** Appropriate for independent tenants, but not needed for the agreed shared administration and operations. Rejected.

## Selection and navigation

- A valid explicit `project_id` in a project view URL takes precedence over the user's last selection in this browser. Otherwise restore that selection if still present, or pick the first available project in the catalog's stable order. Use the ID as the value and disambiguate duplicate names with IDs. Disabled projects remain selectable for historical investigation.
- Preserve the active project in links between project views and on refresh. Switching on a collection page stays on that page; switching on a detail page returns to its parent collection under the new project. Reset old-project resource filters, pagination, and selected rows; retain project-independent filters such as the time range. A detail URL outside its stated project shows not found rather than changing project silently.
- Do not request project-view data until selection is resolved. Show a retryable error if the project catalog cannot load. Keep the first-project onboarding behavior; there is no picker until a project exists. The first successful creation makes the new project available without signing in again.
- The picker remains visible on deployment pages. Switching there updates the project for the next project view but does not modify the current deployment query or settings.
- In Projects, opening or editing a project does not change the header selection. Project-specific links from that detail page (for example, to Endpoints) carry the viewed project's ID and select it when the user enters the scoped view. If project detail shows a summary, it describes that detail page's project, not the header selection.
- Alert notification links without an explicit scope resolve the incident using the existing authenticated detail endpoint and replace the URL with the appropriate project or deployment scope. Explicitly scoped links never fall back to that lookup.

## Data and compatibility

- Scope project-view API requests explicitly using the selected ID, including related picker queries, detail/payload requests, and actions. Apply the scope on the server before filtering, aggregation, and pagination. Check ownership by parent where child records have no project column. A mismatched resource is treated as not found; reject a mixed-project bulk action before applying any changes. Forms create resources in the selected project and cannot link resources from another project.
- Preserve the existing unscoped API behavior for automation and preserve existing route permissions. Add project checks to explicitly scoped calls; do not change token permissions, create a project membership model, or change ingress and deployment jobs. Separate project-only alert counts from deployment alerts without changing the old API's default behavior.
- Include scope in React Query keys for project data. A switch must not show the prior project's cached rows, reuse an old project's cursor, or allow a pending action to be retargeted to the new project. Invalidations must refresh the affected project. Clear cached project data at sign-out as for existing authenticated data.
- Prefer the existing schema and project relationships. This design does not require assigning every audit log or archive batch a project, migrating existing data, or changing backup/restore.

## Acceptance checks

- With two projects containing distinct fixtures, switching changes Overview, Endpoints, Events, Failures, and project alerts without any stale rows, counts, or selector options from the prior project. Verify desktop and mobile header placement and removal of both deployment cards.
- Verify scoped details, payloads, and actions reject mismatched IDs without side effects, and scoped paging and aggregates contain only the selected project. Verify old unscoped API contracts and role checks.
- Verify direct links, refresh, browser history, empty/failed project catalog, first-project onboarding, and disabled projects. Verify a project switch does not change shared settings, users, backups, archives, or audit data.
- Verify Projects lists all projects regardless of the header selection, and opening or editing a project does not switch it. Verify Endpoints lists only the selected project's sources and destinations, and its create forms use that project.
- Update the owning feature documentation after implementation. The builder may decide the exact picker component, route utilities, and test fixture structure, using existing conventions.
