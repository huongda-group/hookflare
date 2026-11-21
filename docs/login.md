# Setup, login, and sessions

[Documentation index](README.md)

## Business rules and current behavior

The public state endpoint reports `setup_required: true` only while no user row has a password hash. The first valid setup request creates the initial admin or promotes an existing password-less account with the same username. It returns `201` and starts a browser session. Concurrent valid requests cannot create two admins: the losing request returns `409 setup_closed` without a session or onboarding audit entry. Disabling an account does not reopen setup.

Login uses username/password. Invalid credentials, disabled users, and password-less users all return `401 invalid_credentials`. New usernames are normalized to lowercase and follow `^[a-z0-9][a-z0-9._@+-]{2,63}$`; login accepts legacy username formats. New passwords are 12–256 characters and cannot equal the username.

Sessions store a SHA-256 token hash in D1. The cookie is `hookflare_session`, HttpOnly, SameSite=Strict, scoped to `/api/admin`, and Secure outside local development. Idle lifetime is 12 hours and absolute lifetime is seven days. The current user is checked on each authenticated request.

## Design and interaction

Public API prefix: `/api/admin/v1/auth`. Routes: `GET /state`, `POST /setup`, `POST /login`, `POST /logout`. The UI uses `/setup` and `/login`, safe local `next` navigation, explicit loading/configuration/errors, and inline invalid-credential feedback.

On desktop, both screens show a shared introduction and an illustrative event → delivery → attempt path. The path does not indicate live system status. Narrow screens show only the auth card, and setup keeps labels, inputs, and help text grouped by field.

Setup accepts `username`, `password`, and `turnstile_token` when required. There is no setup-token field or secret; legacy clients that still send `setup_token` fail strict validation with `400 invalid_request` once the request passes the Origin, rate-limit, and Turnstile checks.

Tokenless setup keeps private self-hosting simple, but setup is first-come: anyone who can reach an uninitialized instance and pass its checks can claim the initial admin. Create that account before making the Worker URL public. Turnstile limits automated abuse; it does not identify the intended owner. See the [deployment runbook](runbook.md).

Login/setup check same-origin requests and share an IP rate limiter before expensive password hashing (10 requests per minute in the checked-in configuration). Turnstile is enforced when both keys are configured; neither key means off with a visible notice; only one means fail closed. A failed provider check is not silently bypassed. Cookie-authenticated mutations require matching Origin; Bearer tokens use a separate authentication path.

Passwords use PBKDF2-HMAC-SHA256 with 100,000 iterations, a random salt, and constant-time comparison. Unknown usernames still take the dummy-hash path. Logout clears the session. See [profile](profile.md), [users](users.md), and [API tokens](api-tokens.md).

## Ideas, boundaries, and open work

Hookflare does not authenticate users from Cloudflare Access JWTs. SSO, OAuth, MFA, passkeys, public self-registration, and email password recovery are not implemented. See [upgrade compatibility](runbook.md#upgrading-from-1x) when replacing an Access-backed deployment.

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
