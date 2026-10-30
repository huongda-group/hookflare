# My account and password

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

Every authenticated user can read `GET /api/admin/v1/me`, returning username, role, and permissions. The account menu shows this identity and offers Change password and Log out. There is no standalone `/profile` page, avatar editor, or editable personal-information form.

`POST /api/admin/v1/me/password` accepts `current_password` and `new_password`. A wrong current password returns `401 wrong_password` without writing an audit row. A valid change writes `user.password_changed` and revokes the other browser sessions. The session making a cookie-authenticated change survives; a Bearer caller has no session to preserve, so all sessions are deleted. API tokens survive a self-service password change.

## Design and interaction

Use a dialog with clear labels, validation, pending state, error feedback, and focus restoration. Keep current-password and new-password fields distinct. Do not display hashes or log passwords. Authentication failures and session expiry must remain recoverable through login.

Admin password reset is a different operation: it revokes all target sessions and API tokens; see [users](users.md).

## Ideas, boundaries, and open work

Profile editing, email verification, recovery codes, MFA, and a session-management screen are not current features. Any extension requires its own business rules and security design.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/admin/routes/me.ts](../apps/gateway/src/admin/routes/me.ts)
- [apps/dashboard/src/components/AccountMenu.tsx](../apps/dashboard/src/components/AccountMenu.tsx)
- [apps/dashboard/src/components/ChangePasswordDialog.tsx](../apps/dashboard/src/components/ChangePasswordDialog.tsx)
- [apps/gateway/test/admin/routes/me.test.ts](../apps/gateway/test/admin/routes/me.test.ts)

