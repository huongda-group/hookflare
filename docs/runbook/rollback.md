# Rollback

Undo a bad release: decide first, then roll back the Worker, verify with
the smoke test, and record what happened.

## <a id="decision-table"></a>Decision table (spec §5.6, verbatim)

| Situation | Action |
|---|---|
| New code is broken; its migrations were expand-only | Roll back the Worker |
| New code is broken; the release has a contract migration or DO migration | Roll forward with a fix |
| A migration or bulk change corrupted data, noticed within 30 days | Time Travel restore (§7.3), then roll back the Worker if needed |
| The database is gone or the problem is older than 30 days | Restore the latest R2 copy into a new database (§7.4) |

(§7.3/§7.4 backup-restore pages land in M6c; until then the last two rows
mean "restore from the D1 Time Travel bookmark recorded by the deploy
script", or escalate.)

In short: expand-only breakage → roll back; a contract migration or a
Durable Object `migrations`-block / Workflow-class change → roll forward
with a fix, because deploying older code cannot undo those. Older code
against a contracted schema (or a migrated DO class) breaks.

## Procedure (verify on staging in drill)

1. **Decide** with the table above. Find the restore point: the failed
   deploy printed it (a successful deploy prints it in its report too), and
   it is stored in `.deploy/<timestamp>.json` (`previousVersion` +
   `bookmark`, plus the ready-made `rollback` commands; git-ignored).
2. **Roll back the Worker** to the version live before the deploy:
   ```bash
   wrangler rollback <previousVersion> --config apps/gateway/wrangler.staging.jsonc
   ```
3. **Smoke-test**:
   ```bash
   pnpm smoke:staging
   ```
   Expected: exit 0, the event ID and two delivery IDs. If it fails, the
   rollback did not fix the problem — treat as an incident, do not retry
   blindly.
4. **Record** the times, versions, and outcome in
   `drills/YYYY-MM-DD-rollback.md`, and note it in the incident.

If data itself is corrupted (table rows 3–4), restore D1 from the recorded
Time Travel bookmark *in addition* — every write after the restore point
is lost, including webhooks already acknowledged with `202`, so only do
this when that loss is smaller than the damage being undone.

## What a rollback does NOT undo (spec §5.5)

- D1 schema and data — migrations are never reversed.
- R2 objects (payloads, archives).
- Queue messages already sent.
- Durable Object migrations.
- Settings changed through the API.

A release that changes the Durable Object `migrations` block or a Workflow
class is **roll-forward only**, and its PR must say so.
