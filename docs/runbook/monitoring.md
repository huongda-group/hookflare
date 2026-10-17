# Monitoring: external checks

What watches Hookflare from the outside, how to set it up, and how to
prove each check fires. Internal alert rules (M5) live in the Alerts
dashboard page; this page covers the external uptime checks (spec §8.2).

> [!NOTE]
> The setup below is derived from the spec and the gateway routes but has
> **not yet been executed against live staging** (the staging canary drill
> is pending). Steps not yet run once are marked **(verify on staging in
> drill)**.

## The three checks

| Check | Request | Expect | Interval |
|---|---|---|---|
| Health | `GET /healthz` | `200` and `"status":"ok"` | 1 min, from ≥ 2 regions |
| Ingress | `POST /in/<canary source id>` with a wrong signature | `401` | 5 min |
| Dashboard | `GET /` without a session | `302` to the Access login | 15 min |

Why these three: Health proves the Worker, D1 (`SELECT 1`), and the job
heartbeat are all alive — `/healthz` returns `503` with
`"reason":"jobs_stale"` when `jobs.heartbeat.reconcile_at` is older than
5 minutes, or is missing while the heartbeat row itself is older than
5 minutes (`apps/gateway/src/app.ts`, `apps/gateway/src/core/heartbeat.ts`;
a fresh database with no heartbeat yet reports `"reason":"jobs_unknown"`
with `200` and counts as healthy; a failed D1 probe is `503`
`"reason":"d1_unavailable"`). The public body is only `status`, `reason`,
and `version` — heartbeat timestamps are read from D1, not `/healthz`.
A failed heartbeat write is logged as `heartbeat.failed` and never fails
the job. Ingress proves webhook intake still verifies
signatures. Dashboard proves the Access application in front of `/` and
`/api/admin/*` is still attached. **Two consecutive failures page the
alert channel** (the same Discord/Slack channel as the M5 alerts).

## 1. Create the canary source (verify on staging in drill)

The canary is an `hmac` source whose destination is the sink: every probe
fails verification, so it never stores anything — it only exercises the
signature check.

1. Point a destination at the sink run URL (dashboard Endpoints page, or
   `POST /api/admin/v1/destinations`).
2. Create an `hmac` source on any project (dashboard Endpoints page, or
   `POST /api/admin/v1/sources`). Note its `id` and the `ingress_url`
   (`https://<host>/in/<id>`) from the response.
3. Add Access **bypass** policies for `/in/*` and `/healthz` so the
   monitor reaches them without logging in (see [setup.md](setup.md)).
   Without the bypass, the probes get Access responses instead of
   gateway responses.

## 2. Worked example: UptimeRobot (verify on staging in drill)

Any uptime service with keyword/status-code matching, ≥ 2 monitoring
locations, and webhook (or Discord/Slack) notifications works. This
example uses UptimeRobot's free plan; alternatives are listed below.

1. **Health** — HTTP monitor, `https://<host>/healthz`, 1-minute
   interval, alert when the keyword `"status":"ok"` is absent or the
   status is not `200`. Enable at least two monitoring locations.
2. **Ingress** — HTTP monitor with a custom POST body against
   `https://<host>/in/<canary source id>` (any body with a wrong
   `X-Hub-Signature-256` header), 5-minute interval, alert unless the
   status is `401`.
3. **Dashboard** — HTTP monitor, `https://<host>/`, 15-minute interval,
   alert unless the status is `302` to `<team>.cloudflareaccess.com`.
4. Point UptimeRobot notifications at the same Discord/Slack channel as
   the M5 alerts. **Two consecutive failures page the channel** — set the
   monitor to alert after 2 consecutive failures, not 1, to avoid paging
   on a single dropped probe.

> [!NOTE]
> Free-plan minimum intervals vary by vendor. If the chosen plan cannot
> do 1-minute health checks, say so in the drill record and either accept
> the slower interval or pick another vendor — do not silently run a
> 5-minute health check while this page says 1 minute.

Alternatives (same three checks, different vendor): HetrixTools,
Better Stack, Checkly, or a self-hosted Uptime Kuma. Picking one is an
account decision for the team; the checks matter, not the vendor.

## 3. Prove each check fires (PENDING — live staging drill not yet run)

Step 1 of this task (stop the cron on a staging copy so `/healthz`
turns `503 jobs_stale` within 6 minutes, confirm the monitor pages, then
redeploy) needs staging approval and is **not yet run**. When it runs,
also confirm the ingress check pages on a `5xx` (temporarily break the
canary destination is not needed — instead confirm a wrong-signature
probe returns `401` by hand with `curl`, and confirm the monitor's
failure notification reaches the channel) and record everything in a
drill note under `drills/`.
