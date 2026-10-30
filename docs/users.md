# Users and permissions

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

Roles apply globally within a deployment. Each role includes the permissions of the previous role.

| Role | Permissions |
| --- | --- |
| Viewer | `events.read`: inspect metadata, statistics, and delivery history |
| Operator | Viewer plus `payload.read`, `deliveries.replay`, `destinations.operate` |
| Admin | Operator plus `config.write`, `users.manage`, `audit.read`, `settings.manage` |

Admins create accounts with an initial password, change roles, disable users, and reset passwords. The last active password-bearing admin cannot be disabled or demoted. Legacy password-less identities do not satisfy that guard. Disabling an account removes sessions; authentication checks the user on each request.

## Design and interaction

Settings → Users is visible with `users.manage`. API routes under `/api/admin/v1/users`: GET/POST collection, PATCH `/:username`, and POST `/:username/password`. Password reset revokes sessions and API tokens and records a redacted audit entry. Usernames are identifiers, not editable display names.

Hide unavailable UI actions, but enforce permissions on the server. A stale role or direct URL must still receive a meaningful 403. Never treat hidden navigation as the security boundary. [Token management](api-tokens.md) is scoped to a user.

## Ideas, boundaries, and open work

Per-project roles and custom roles are backlog ideas. Historical email/Access service identities are migration context, not a second supported login mode.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/core/rbac.ts](../apps/gateway/src/core/rbac.ts)
- [apps/gateway/src/admin/routes/users.ts](../apps/gateway/src/admin/routes/users.ts)
- [apps/dashboard/src/pages/settings/UsersTab.tsx](../apps/dashboard/src/pages/settings/UsersTab.tsx)
- [apps/gateway/test/admin/rbac-matrix.test.ts](../apps/gateway/test/admin/rbac-matrix.test.ts)
- [apps/gateway/test/admin/users.test.ts](../apps/gateway/test/admin/users.test.ts)

