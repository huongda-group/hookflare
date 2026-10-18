# PENDING — live staging drill not yet run

Restore drill record template (spec §7.5). Fill in the time table when
the drill is run on live staging. Procedures:
[backup-restore.md](../backup-restore.md).

## Setup

- Staging Worker URL: _
- Sink URL: _
- API token (created for an admin user; exported as `HOOKFLARE_API_TOKEN`): _
- Starting version (`wrangler deployments list --json`): _
- Backup prefix under test (`d1/YYYY/MM/DD/<backup_id>/`): _

## Path A — Time Travel (in place)

| # | Step | Time (UTC) | Result |
|---|---|---|---|
| A1 | Record bookmark: `wrangler d1 time-travel info <d1-name> --json` | | |
| A2 | Delete one project's events through SQL (the controlled damage) | | |
| A3 | Restore: `wrangler d1 time-travel restore <d1-name> --bookmark=<bookmark>` (keep the printed "undo" bookmark: _) | | |
| A4 | Verify row counts match the pre-delete numbers | | |
| A5 | Smoke: `pnpm smoke:staging` (exit 0, event ID + two delivery IDs) | | |

## Path B — R2 copy into a new database

| # | Step | Time (UTC) | Result |
|---|---|---|---|
| B1 | `wrangler d1 create hookflare-restore-<date>`; apply migrations up to the manifest's last `d1_migrations` | | |
| B2 | `node scripts/restore-backup.mjs --prefix <prefix> --config <restore-config>` (rows restored: _; orphans: _) | | |
| B3 | `node scripts/verify-restore.mjs --prefix <prefix> --config <restore-config>` (all checks pass) | | |
| B4 | Point scratch Worker (`hookflare-restore-drill`) at the restored database; deploy; smoke | | |
| B5 | Delete the scratch database and Worker | | |

## Outcome

| Path | RTO (wall-clock) | RPO (data window lost) |
|---|---|---|
| A (Time Travel) | _ | _ |
| B (R2 copy) | _ | _ |

- Surprises / runbook fixes: _
