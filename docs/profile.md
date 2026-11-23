# My account and password

[Documentation index](README.md)

## Business rules and current behavior

Every authenticated user can read `GET /api/admin/v1/me`, which needs no permission and returns `username`, `role`, `permissions`, and `project_required` (true while the deployment has no project). The dashboard uses it to show or hide actions. The account button in the top-right header shows the username initials, username, and role on desktop and mobile. It opens a menu with Change password and Log out; Change password is hidden while a first project is required, because every other admin route, including the password change, returns `409 project_required` until then (see [contract](contract.md)). There is no standalone `/profile` page, avatar editor, or editable personal-information form.

`POST /api/admin/v1/me/password` accepts `current_password` and `new_password`. The new password follows the [shared password rules](login.md#business-rules-and-current-behavior). The route checks, in order: the request body (`400 invalid_request`); the login rate limiter keyed `password:<username>`, so PBKDF2 guesses are bounded per account (`429 too_many_attempts`); the current password (`401 wrong_password`, with nothing written and no audit entry); and that the new password differs from the username (`400 password_equals_username`). A successful change returns `204`, and the password update, the `user.password_changed` audit entry, and the revocation of the account's other browser sessions run in one database batch. The update only applies while the stored hash is still the one that was verified, so if an [admin password reset](users.md) lands during verification, the change returns `401 wrong_password` and the reset wins.

## Design and interaction

The Change password dialog has distinct Current password, New password, and Confirm new password fields with show/hide toggles. It checks the minimum length and that the confirmation matches before enabling Save; the server re-checks everything, and passwords are never trimmed. A wrong current password shows "Current password is incorrect" inline and does not end the session; the dashboard treats that `401` as a form error, not as an expired session. On success the dialog confirms that other sessions were signed out. The dialog unmounts on close, so every open starts with empty fields, and focus returns to the account button. Hashes and passwords are never displayed or logged. Authentication failures and session expiry remain recoverable through [login](login.md).

The session making a cookie-authenticated change stays signed in. A Bearer caller has no browser session to preserve, so all of the user's browser sessions are revoked. A self-service change leaves [API tokens](api-tokens.md) active. An [admin password reset](users.md) instead revokes all of the target user's sessions and tokens.

## Ideas, boundaries, and open work

Profile editing, email verification, recovery codes, MFA, and a session-management screen are not current features. Any extension requires its own business rules and security design.

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/admin/routes/me.ts](../apps/gateway/src/admin/routes/me.ts)
- [apps/gateway/src/admin/router.ts](../apps/gateway/src/admin/router.ts)
- [packages/shared/src/admin.ts](../packages/shared/src/admin.ts)
- [apps/dashboard/src/components/AccountMenu.tsx](../apps/dashboard/src/components/AccountMenu.tsx)
- [apps/dashboard/src/components/ChangePasswordDialog.tsx](../apps/dashboard/src/components/ChangePasswordDialog.tsx)
- [apps/dashboard/src/components/AppShell.tsx](../apps/dashboard/src/components/AppShell.tsx)
- [apps/gateway/tests/admin/routes/me.test.ts](../apps/gateway/tests/admin/routes/me.test.ts)
- [apps/dashboard/tests/components/dialogs.test.tsx](../apps/dashboard/tests/components/dialogs.test.tsx)
