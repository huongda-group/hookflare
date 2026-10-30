# API tokens and automation

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

An API token authenticates automation as its owning user, with that user's current role. Admins create, list, and revoke tokens. Plaintext `hf_…` is shown once; only the hash is stored. A token can expire or be revoked, and a disabled or password-less owner cannot authenticate.

Use `Authorization: Bearer <token>`. A request carrying both a session cookie and a Bearer token is rejected with 400. Admin password reset revokes tokens; self-service password change leaves them active.

## Design and interaction

Routes are nested under `/api/admin/v1/users/:username/tokens`: GET list, POST create, POST `/:id/revoke`. Creation takes a name, optional expiry, and optional reason; list responses never reveal the secret or hash.

Settings → Users opens the token dialog. Show the secret once with an explicit acknowledgement before dismissal. Smoke/deploy/benchmark automation uses `HOOKFLARE_API_TOKEN`; never put it in documentation, screenshots, or committed environment files.

## Ideas, boundaries, and open work

Tokens have user-level permissions, not independent scopes. The historical Access service-token workflow is superseded.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/admin/routes/api-tokens.ts](../apps/gateway/src/admin/routes/api-tokens.ts)
- [apps/gateway/src/admin/auth/session.ts](../apps/gateway/src/admin/auth/session.ts)
- [apps/dashboard/src/components/ApiTokensDialog.tsx](../apps/dashboard/src/components/ApiTokensDialog.tsx)
- [apps/gateway/test/admin/routes/api-tokens.test.ts](../apps/gateway/test/admin/routes/api-tokens.test.ts)

