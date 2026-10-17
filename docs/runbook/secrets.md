# Secrets

How the secrets Hookflare depends on are stored, re-entered after a
restore, and rotated when they leak.

> [!NOTE]
> The commands below are derived from the repository configs and admin
> API but have **not yet been executed against live staging** (the restore
> drill is pending). Every live-staging command is marked **(verify on
> staging in drill)**.

## `SECRETS_KEY`: the one thing a backup cannot replace

Without `SECRETS_KEY`, every source secret, signing secret, and alert
channel config in a restored database is unreadable — the restore
succeeds but nothing verifies and no alert delivers. A backup never
contains the key.

- **Keep `SECRETS_KEY` in the team password manager, with who has
  access.** It is 32 random bytes, base64-encoded
  (`openssl rand -base64 32`). Losing it means re-entering every secret
  below by hand.
- `SECRETS_KEY_PREVIOUS` (accepted for decryption only) exists so a key
  rotation can proceed without breaking reads of secrets encrypted under
  the old key.

## Re-enter after a restore or on a new deployment

A restored (or brand-new) deployment needs these secrets before it works:

| Secret | How to set |
|---|---|
| `SECRETS_KEY` | `pnpm exec wrangler secret put SECRETS_KEY --config <config>` (verify on staging in drill), pasting the value from the password manager |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | Service token for automation; add its `svc:<client id>` identity as operator through the dashboard Users page (see [setup.md](setup.md)) |
| Source webhook secrets | Re-create each source through the dashboard or admin API; providers must be given the new signing secret |
| Destination signing secrets | Re-enter per destination through the dashboard or admin API |
| Alert channel configs (Discord/Slack/Telegram) | Re-enter through the dashboard or admin API; channel configs are encrypted and never returned by the API |

For local development, `SECRETS_KEY` (and `ACCESS_DEV_EMAIL`) live in
`apps/gateway/.dev.vars`, copied from `.dev.vars.example` — never commit
the real file.

## Leaked secrets: rotate through the API

Rotate a leaked **source or destination secret** through the dashboard or
the admin API (the rotation has a grace window for the previous value).
Note the inbound source cache: **a rotated secret keeps being accepted
for up to 30 s** after the change, while the cached source bundle
expires — wait half a minute before treating the old secret as dead.

Rotate a leaked **`SECRETS_KEY`** by setting the new key with
`wrangler secret put SECRETS_KEY` (verify on staging in drill), keeping
the old value as `SECRETS_KEY_PREVIOUS` until secrets encrypted under it
have been re-entered, then removing it.

A D1 restore never leaks or fixes secrets: it restores the encrypted
values as they were at the restore point, decrypted with whatever
`SECRETS_KEY` the Worker holds. After path A, secrets rotated *after*
the restore point revert to their old values — re-rotate them.
