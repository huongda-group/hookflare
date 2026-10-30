# Setup, login, and sessions

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

The public state endpoint determines whether setup is required: no user row has a non-null password hash. Setup requires `SETUP_TOKEN`, creates the first admin and session atomically, and closes when a password-bearing account exists. A concurrent losing setup request returns `409 setup_closed`; a missing configured setup token returns `503 setup_token_missing`.

Login uses username/password. Invalid credentials, disabled users, and password-less users all return `401 invalid_credentials`. New usernames are normalized to lowercase and follow `^[a-z0-9][a-z0-9._@+-]{2,63}$`. Passwords are 12–256 characters and cannot equal the username.

Sessions store a SHA-256 token hash in D1. The cookie is `hookflare_session`, HttpOnly, SameSite=Strict, scoped to `/api/admin`, and Secure outside local development. Idle lifetime is 12 hours and absolute lifetime is seven days. The current user is checked on each authenticated request.

## Design and interaction

Public API prefix: `/api/admin/v1/auth`. Routes: `GET /state`, `POST /setup`, `POST /login`, `POST /logout`. The UI uses `/setup` and `/login`, safe local `next` navigation, explicit loading/configuration/errors, and inline invalid-credential feedback.

Login/setup check same-origin requests and an IP rate limiter before expensive password hashing. Turnstile is enforced when both keys are configured; neither key means off with a visible notice; only one means fail closed. A failed provider check is not silently bypassed. Cookie-authenticated mutations require matching Origin; Bearer tokens use a separate authentication path.

Passwords use PBKDF2-HMAC-SHA256 with 100,000 iterations, a random salt, and constant-time comparison. Unknown usernames still take the dummy-hash path. Logout clears the session. See [profile](profile.md), [users](users.md), and [API tokens](api-tokens.md).

## Ideas, boundaries, and open work

Built-in auth supersedes the old Cloudflare Access identity design. SSO, OAuth, MFA, passkeys, public self-registration, and email password recovery are not implemented. Do not infer these from the word “profile”.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [apps/gateway/src/admin/routes/auth.ts](../apps/gateway/src/admin/routes/auth.ts)
- [apps/gateway/src/admin/auth/session.ts](../apps/gateway/src/admin/auth/session.ts)
- [apps/gateway/src/admin/auth/password.ts](../apps/gateway/src/admin/auth/password.ts)
- [apps/gateway/src/core/db/sessions.ts](../apps/gateway/src/core/db/sessions.ts)
- [packages/shared/src/admin.ts](../packages/shared/src/admin.ts)
- [apps/dashboard/src/pages/LoginPage.tsx](../apps/dashboard/src/pages/LoginPage.tsx)
- [apps/dashboard/src/pages/SetupPage.tsx](../apps/dashboard/src/pages/SetupPage.tsx)
- [apps/gateway/test/admin/routes/auth.test.ts](../apps/gateway/test/admin/routes/auth.test.ts)

