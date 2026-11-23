# API tokens and automation

[Documentation index](README.md)

## Business rules and current behavior

An API token authenticates automation as its owning user, with that user's current role; tokens have no scopes of their own. Admins (`users.manage`) create, list, and revoke tokens for any user. A token is `hf_` followed by 32 random bytes in base64url; the plaintext is returned once at creation and only its SHA-256 hash is stored. A token stops authenticating when it expires, is revoked, or its owner is disabled or has no password hash; the owner's row is read on every request, so this applies immediately.

Use `Authorization: Bearer <token>` (the scheme is case-insensitive). A Bearer value without the `hf_` prefix, or an unknown, expired, or revoked token, returns `401 unauthorized`. A request carrying both a session cookie and a Bearer token is rejected with `400 ambiguous_credentials`. Bearer requests skip the `Origin` check that cookie-authenticated mutations need, because browsers never send them implicitly. A token's `last_used_at` is updated on first use and then at most every five minutes.

Admin password reset revokes all of the user's tokens; self-service password change leaves them active. Disabling a user revokes all of their live tokens in the same batch as the disable, and only if the disable applied. When at least one token was revoked, an `api_token.revoked` audit entry on the user lists the revoked token IDs with cause `user.disabled`. Re-enabling does not restore them. A token can be created for a disabled user; it authenticates only after the user is re-enabled.

## Design and interaction

Routes are nested under `/api/admin/v1/users/:username/tokens`, all requiring `users.manage`:

- `GET /` lists the user's tokens newest first (`404 not_found` for an unknown user), including revoked and expired ones. Items have `id`, `username`, `name`, `created_at`, `expires_at`, `last_used_at`, and `revoked_at`, never the secret or hash.
- `POST /` takes `name` (1–100 characters), optional `expires_in_days` (1–365; omitted means no expiry), and optional `reason`. It returns `201` with the token item plus `token`, the only response that carries the secret. An unknown user is `404 not_found`; a user without a password hash is `409 user_has_no_password`. Audited as `api_token.created` with the username and token name.
- `POST /:id/revoke` takes no body and returns `204`, audited as `api_token.revoked`. A token that is unknown, already revoked, or owned by another user returns `404 not_found` and writes no audit entry.

Settings → Users opens the token dialog from a user's row, including the signed-in admin's own row, where API tokens is the only action. A dedicated automation account is still preferable for long-lived automation, so that rotating a person's password does not break it. The dialog lists each token's name, creation time, expiry, and revoked state, and creates tokens by name only (no expiry or reason). The new secret appears in a reveal dialog that cannot be dismissed until the admin confirms it was stored; closing the token dialog drops the secret and any error. Revoking asks for confirmation without a reason field.

Smoke/deploy/benchmark automation uses `HOOKFLARE_API_TOKEN`; never put it in documentation, screenshots, or committed environment files.

## Ideas, boundaries, and open work

Tokens have user-level permissions, not independent scopes. Expiry and reason are available through the API but not in the dashboard form.

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/admin/routes/api-tokens.ts](../apps/gateway/src/admin/routes/api-tokens.ts)
- [apps/gateway/src/admin/auth/session.ts](../apps/gateway/src/admin/auth/session.ts)
- [apps/gateway/src/core/db/api-tokens.ts](../apps/gateway/src/core/db/api-tokens.ts)
- [packages/shared/src/admin.ts](../packages/shared/src/admin.ts)
- [apps/dashboard/src/components/ApiTokensDialog.tsx](../apps/dashboard/src/components/ApiTokensDialog.tsx)
- [apps/dashboard/src/components/SecretRevealDialog.tsx](../apps/dashboard/src/components/SecretRevealDialog.tsx)
- [apps/gateway/tests/admin/routes/api-tokens.test.ts](../apps/gateway/tests/admin/routes/api-tokens.test.ts)
- [apps/gateway/tests/core/db/api-tokens.test.ts](../apps/gateway/tests/core/db/api-tokens.test.ts)
- [apps/dashboard/tests/components/ApiTokensDialog.test.tsx](../apps/dashboard/tests/components/ApiTokensDialog.test.tsx)
