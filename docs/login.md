# Setup, login, and sessions

[Documentation index](README.md)

## Business rules and current behavior

The public state endpoint reports `setup_required: true` only while no user row has a password hash, plus the Turnstile site key (or `null` when Turnstile is off). The first valid setup request creates the initial admin, or promotes an existing password-less row with the same username to an enabled admin. It returns `201` with `{ username, role: "admin" }`, records `user.onboarded`, and starts a browser session. The account write, the audit row, and the session insert run in one database batch, and the audit row and session are written only if the account write changed a row. Concurrent valid requests therefore cannot create two admins: the losing request returns `409 setup_closed` without a session or audit entry. Disabling an account does not reopen setup, because a disabled account still has a password hash. Password-less rows exist only after the [runbook's onboarding recovery](runbook.md) or direct database edits; the admin API always sets a password.

Login uses username/password and returns `204` with a session cookie. The submitted username is trimmed and lowercased (1–254 characters) and looked up as is; login does not apply the username creation pattern, so any existing account can sign in. Unknown users, disabled users, password-less users, and wrong passwords all return `401 invalid_credentials`. Every attempt runs exactly one PBKDF2 pass, against a dummy hash when the user is unknown or has no valid hash, so response timing does not reveal which usernames exist. Login success and failure are written to Worker logs (`admin.login_ok`, `admin.login_failed` with the failure reason), not to the audit trail.

Usernames created through setup or [user administration](users.md) are trimmed, lowercased, and must match `^[a-z0-9][a-z0-9._@+-]{2,63}$`. Passwords are 6–256 characters, are never trimmed or normalized, and cannot equal the username (`400 password_equals_username`).

Sessions store only a SHA-256 hash of the random token in D1. The cookie is `hookflare_session`, HttpOnly, SameSite=Strict, scoped to `/api/admin`, with a seven-day Max-Age, and Secure except on `localhost`/`127.0.0.1`. A session expires 12 hours after its last activity or seven days after creation, whichever comes first; activity extends it at most every five minutes and never past the seven-day cap. Each authenticated request reads the user row, so disabling a user, changing their role, or clearing their password takes effect on the next request. Signing in with an existing session cookie ends that previous session in the same database batch. Expired sessions are purged by the per-minute scheduled job.

## Design and interaction

Public API prefix: `/api/admin/v1/auth`. Routes: `GET /state`, `POST /setup`, `POST /login`, `POST /logout`. The authentication middleware does not run for these routes.

Login and setup check, in order: same-origin `Origin` (`403 bad_origin`), the shared per-IP rate limiter keyed on `CF-Connecting-IP`, never the username (`429 too_many_attempts`; 10 requests per minute in the checked-in configuration), body size and JSON (`400 invalid_request`; a body over 64 KiB is a `400` here rather than the `413` other admin routes return), then Turnstile and schema validation, all before password hashing. Setup checks Turnstile before strict schema validation; login validates its body first. Setup accepts only `username`, `password`, and `turnstile_token`; any other field fails strict validation with `400 invalid_request`. There is no setup token or setup secret.

Turnstile is enforced when both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set and is off when neither is; the auth pages then show "Bot protection is off." Exactly one key is a misconfiguration and fails closed with `500 internal_error`. A missing, oversized (over 2,048 characters), or rejected token, or a token issued for a different action or hostname, returns `403 turnstile_failed`; an unreachable, timed-out, or unparseable siteverify returns `503 turnstile_unavailable`. A failed provider check is never bypassed. The Cloudflare always-pass test secret skips only the action and hostname checks, for local development and end-to-end tests.

Logout requires a same-origin `Origin`, deletes the session if the cookie names one, clears the cookie, and returns `204`.

Tokenless setup keeps private self-hosting simple, but setup is first-come: anyone who can reach an uninitialized instance and pass its checks can claim the initial admin. Create that account before making the Worker URL public. Turnstile limits automated abuse; it does not identify the intended owner. See the [deployment runbook](runbook.md).

The dashboard loads the auth state before rendering any route: while setup is required, every route redirects to `/setup`; afterwards `/setup` redirects to `/login`. If the state cannot load, the auth pages show a retry alert and keep the submit button disabled. The Sign in button stays disabled until Turnstile yields a token when a site key is configured; tokens are single-use, so the widget resets after every failed submit. A `401` shows "Invalid username or password" and a `429` shows "Too many attempts, try again in a minute" inline; validation issues appear on their fields, and the first invalid field receives focus. Setup adds a client-only Confirm password field and username help text; a `409` from setup refreshes the auth state and navigates to `/login`.

Any `401` from a protected admin route (other than `wrong_password` from a [password change](profile.md)) sends the user to `/login?next=<current location>`. After sign-in, `next` is honored only if it is a same-origin absolute dashboard path other than `/login` or `/setup`; anything else lands on `/`. After setup or sign-in, if the deployment has no project, the dashboard opens `/projects` instead (including instead of a login `next` URL). See [first project onboarding](projects.md#design-and-interaction).

Selecting **Log out** in the dashboard account menu opens a confirmation dialog. **Cancel** or **Esc** leaves the current page and session unchanged. Confirming sends the logout request, clears all cached dashboard data, and returns to `/login` even if the request fails.

On desktop, both screens show a shared introduction and an illustrative event → delivery → attempt path. The three steps are spaced across the card, with each icon centered over its label. The path does not indicate live system status. Narrow screens show only the auth card. Setup keeps labels, inputs, and help text grouped by field; Tab moves through Username, Password, and Confirm password before the two visibility controls. The password controls remain keyboard-operable and keep their hover highlight inside the input border.

Passwords use PBKDF2-HMAC-SHA256 with 100,000 iterations (the Workers runtime maximum), a random 16-byte salt, and constant-time comparison. Each stored hash records its algorithm and iteration count, so the cost can be raised without invalidating existing hashes; a malformed stored hash fails closed. See [profile](profile.md), [users](users.md), and [API tokens](api-tokens.md).

## Ideas, boundaries, and open work

Hookflare does not authenticate users from Cloudflare Access JWTs. SSO, OAuth, MFA, passkeys, public self-registration, and email password recovery are not implemented.

## Source and verification entry points

The files below define this behavior and its tests.

- [apps/gateway/src/admin/routes/auth.ts](../apps/gateway/src/admin/routes/auth.ts)
- [apps/gateway/src/admin/auth/session.ts](../apps/gateway/src/admin/auth/session.ts)
- [apps/gateway/src/admin/auth/password.ts](../apps/gateway/src/admin/auth/password.ts)
- [apps/gateway/src/admin/auth/turnstile.ts](../apps/gateway/src/admin/auth/turnstile.ts)
- [apps/gateway/src/core/db/sessions.ts](../apps/gateway/src/core/db/sessions.ts)
- [packages/shared/src/admin.ts](../packages/shared/src/admin.ts)
- [apps/dashboard/src/pages/LoginPage.tsx](../apps/dashboard/src/pages/LoginPage.tsx)
- [apps/dashboard/src/pages/SetupPage.tsx](../apps/dashboard/src/pages/SetupPage.tsx)
- [apps/dashboard/src/components/AuthLayout.tsx](../apps/dashboard/src/components/AuthLayout.tsx)
- [apps/dashboard/src/lib/next.ts](../apps/dashboard/src/lib/next.ts)
- [apps/gateway/tests/admin/routes/auth.test.ts](../apps/gateway/tests/admin/routes/auth.test.ts)
- [apps/gateway/tests/admin/auth/session.test.ts](../apps/gateway/tests/admin/auth/session.test.ts)
- [apps/gateway/tests/admin/auth/password.test.ts](../apps/gateway/tests/admin/auth/password.test.ts)
- [apps/gateway/tests/admin/auth/turnstile.test.ts](../apps/gateway/tests/admin/auth/turnstile.test.ts)
- [apps/gateway/tests/core/db/sessions.test.ts](../apps/gateway/tests/core/db/sessions.test.ts)
- [apps/dashboard/tests/pages/LoginPage.test.tsx](../apps/dashboard/tests/pages/LoginPage.test.tsx)
- [apps/dashboard/tests/pages/SetupPage.test.tsx](../apps/dashboard/tests/pages/SetupPage.test.tsx)
- [apps/dashboard/tests/lib/next.test.ts](../apps/dashboard/tests/lib/next.test.ts)
