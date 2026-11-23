# Users and permissions

[Documentation index](README.md)

## Business rules and current behavior

Roles apply globally within a deployment. Each role includes the permissions of the previous role.

| Role | Permissions |
| --- | --- |
| Viewer | `events.read`: inspect metadata, statistics, and delivery history |
| Operator | Viewer plus `payload.read`, `deliveries.replay`, `destinations.operate` |
| Admin | Operator plus `config.write`, `users.manage`, `audit.read`, `settings.manage` |

Admins (`users.manage`) create accounts with an initial password, change roles, disable and re-enable users, and reset passwords. Usernames are identifiers, not editable display names; there is no rename or delete. New usernames follow the [username rule](login.md#business-rules-and-current-behavior); the `:username` path parameter is only trimmed and lowercased, so any existing row can be managed.

The last enabled, password-bearing admin cannot be demoted or disabled (`409 last_admin`). The check runs inside the conditional update, so two concurrent demotions cannot both pass. A password-less admin row does not count, because it cannot sign in. An admin cannot disable their own account (`409 self_disable`). Role and disabled state are read on every request, so a change applies to the user's next request.

A user row without a password hash (`has_password: false`) cannot sign in or authenticate with a session or token, and cannot receive new API tokens (`409 user_has_no_password`). An admin password reset gives such a row a password. See [login](login.md) for how setup claims a password-less row.

Disabling a user revokes all of their live [API tokens](api-tokens.md) in the same batch as the update and then deletes their sessions; re-enabling restores neither. An admin password reset treats the account as compromised: the new hash, deletion of all the user's sessions, and revocation of all their API tokens run in one batch. A reset does not re-enable a disabled user.

## Design and interaction

API routes under `/api/admin/v1/users`, all requiring `users.manage`:

- `GET /` lists users ordered by username, with a username cursor (`limit` 1–100, default 50). Each item has `username`, `role`, `created_at`, `updated_at`, `disabled_at`, and `has_password`.
- `POST /` takes `username`, `role`, `password`, and optional `reason`; returns `201`, or `409 user_exists`. Audited as `user.created`.
- `PATCH /:username` takes `role` and/or `disabled`, plus optional `reason`. A request that changes nothing returns the current user and writes nothing. Otherwise it records one audit entry: `user.disabled` or `user.enabled` when `disabled` is sent, else `user.role_changed`, with the role change in the diff. An unknown user is `404 not_found`.
- `POST /:username/password` takes `password` and optional `reason`; returns `204` and records `user.password_reset` with no password data in the diff.
- `/:username/tokens` is [API token management](api-tokens.md).

Settings → Users is visible with `users.manage`. An add-user row takes username (trimmed and lowercased before sending), password, and role. The table shows each user's role selector, status badge with the disable time, and row actions: Reset password, API tokens, and Enable or Disable. The signed-in user's row has a locked role selector and offers only API tokens, so the first admin can issue a token for automation. Role changes and enable/disable go through a confirmation with an optional reason. The reset dialog asks before closing while a typed password is unsaved, clears it on every close, and on success tells the admin that the user was signed out everywhere and the new password must be handed over out of band.

Hide unavailable UI actions, but enforce permissions on the server: `requirePermission()` answers `403 forbidden` with the `required` permission, and a router test asserts that every admin route except `/me` and the public auth routes declares one. A stale role or direct URL must still receive a meaningful 403. Never treat hidden navigation as the security boundary.

## Ideas, boundaries, and open work

Per-project roles and custom roles are backlog ideas. Cloudflare Access or email identities are not a login mode; every account is a username with a password.

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/core/rbac.ts](../apps/gateway/src/core/rbac.ts)
- [apps/gateway/src/admin/auth/permission.ts](../apps/gateway/src/admin/auth/permission.ts)
- [apps/gateway/src/admin/routes/users.ts](../apps/gateway/src/admin/routes/users.ts)
- [apps/gateway/src/core/db/users.ts](../apps/gateway/src/core/db/users.ts)
- [packages/shared/src/admin.ts](../packages/shared/src/admin.ts)
- [apps/dashboard/src/pages/settings/UsersTab.tsx](../apps/dashboard/src/pages/settings/UsersTab.tsx)
- [apps/gateway/tests/admin/rbac-matrix.test.ts](../apps/gateway/tests/admin/rbac-matrix.test.ts)
- [apps/gateway/tests/admin/permission.test.ts](../apps/gateway/tests/admin/permission.test.ts)
- [apps/gateway/tests/admin/router.test.ts](../apps/gateway/tests/admin/router.test.ts)
- [apps/gateway/tests/admin/users.test.ts](../apps/gateway/tests/admin/users.test.ts)
- [apps/gateway/tests/core/rbac.test.ts](../apps/gateway/tests/core/rbac.test.ts)
- [apps/dashboard/tests/pages/settings/UsersTab.test.tsx](../apps/dashboard/tests/pages/settings/UsersTab.test.tsx)
