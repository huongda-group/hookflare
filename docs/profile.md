# My account and password

[Documentation index](README.md)

## Business rules and current behavior

Every authenticated user can read `GET /api/admin/v1/me`, returning username, role, and permissions. The account menu shows this identity and offers Change password and Log out. There is no standalone `/profile` page, avatar editor, or editable personal-information form.

`POST /api/admin/v1/me/password` accepts `current_password` and `new_password`. The new password must be 12–256 characters and not equal the username. A wrong current password returns `401 wrong_password` without a password-change audit entry. A successful change returns `204`, records `user.password_changed`, and revokes the account's other browser sessions in the same database batch as the password update.

## Design and interaction

Use a dialog with clear labels, validation, pending state, error feedback, and focus restoration. Keep current-password and new-password fields distinct. Do not display hashes or log passwords. Authentication failures and session expiry must remain recoverable through login.

The session making a cookie-authenticated change stays signed in. A Bearer caller has no browser session to preserve, so all browser sessions are revoked. A self-service change leaves [API tokens](api-tokens.md) active. An [admin password reset](users.md) instead revokes all of the target user's sessions and tokens.

## Ideas, boundaries, and open work

Profile editing, email verification, recovery codes, MFA, and a session-management screen are not current features. Any extension requires its own business rules and security design.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/admin/routes/me.ts](../apps/gateway/src/admin/routes/me.ts)
- [packages/shared/src/admin.ts](../packages/shared/src/admin.ts)
- [apps/dashboard/src/components/AccountMenu.tsx](../apps/dashboard/src/components/AccountMenu.tsx)
- [apps/dashboard/src/components/ChangePasswordDialog.tsx](../apps/dashboard/src/components/ChangePasswordDialog.tsx)
- [apps/gateway/test/admin/routes/me.test.ts](../apps/gateway/test/admin/routes/me.test.ts)
