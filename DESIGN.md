# Webhook Hub — System Specification

## 1. Product Definition

**Goal:** Build a centralized Inbound Webhook Gateway that serves many projects. It receives and stores webhooks before forwarding them to backends. When a backend fails, the system retries automatically and provides complete delivery logs.

**Principle:** Reliability first. Do not build an integration platform or workflow automation.

| Attribute | Specification |
|---|---|
| System type | Inbound Webhook Gateway |
| Scope | Multi-project, internal administration |
| Infrastructure | 100% Cloudflare managed |
| Backend | TypeScript + Hono on Workers |
| Database | Cloudflare D1 |
| Message queue | Cloudflare Queues |
| Payload storage | D1 + R2 for large payloads |
| Authentication | Cloudflare Access |
| Admin Dashboard | React + Tailwind |
| Delivery semantics | At-least-once |
| Retry | Automatic, exponential backoff |
| Deployment | Wrangler, separate staging/production |

## 2. Required Modules

| Module | Function | Priority |
|---|---|---|
| Project Management | Manage multiple independent projects | P0 |
| Webhook Sources | Create webhook intake URLs, authenticate sources | P0 |
| Destinations | Manage the backends that receive webhooks | P0 |
| Webhook Receiver | Validate, deduplicate, store, and enqueue | P0 |
| Delivery Engine | Send webhooks to backends, handle timeouts | P0 |
| Retry Engine | Automatic retries with delay | P0 |
| Dead Letter Queue | Store and manage failed deliveries | P0 |
| Delivery Logs | Record the history of every request | P0 |
| Manual Replay | Resend webhooks from the dashboard | P0 |
| Dashboard | Statistics, search, management | P0 |
| Authentication/RBAC | Sign-in and authorization | P0 |
| Reconciliation | Recover stuck jobs or failed enqueues | P0 |
| Alerting | Incident alerts | P1 |
| Retention & Cleanup | Clean up expired data | P0 |

## 3. Architecture

```text
External Services
       |
       v
Cloudflare Ingress Worker
       |
       +---- D1 Event Ledger
       |         |
       |         +---- R2 (large payloads)
       |
       v
Cloudflare Queues
       |
       v
Delivery Worker
       |
       +----> Backend API
       |         |
       |         +-- 2xx: Success
       |         +-- 5xx: Retry
       |         +-- 429: Backoff
       |         +-- Timeout: Retry
       |
       +----> D1 Delivery Attempts
       |
       +----> DLQ after retry exhaustion

Admin Dashboard ---> Admin API ---> D1
       |
       +-- Manual Replay
       +-- Pause / Resume
       +-- Endpoint Settings
       +-- Delivery Logs

Cron Reconciler ---> Find stale jobs ---> Re-enqueue
```

**Key technical requirement:** Return `202 Accepted` only after the payload has been durably stored **and** the enqueue has succeeded. If the D1 write succeeds but the Queue send fails, return `503`; the Cron Reconciler recovers the job from D1. Idempotency is mandatory to prevent duplicate processing.

## 4. Admin Dashboard Specification

### 4.1. Overview

| Component | Content |
|---|---|
| Total Received | Total webhooks received |
| Delivered | Total webhooks delivered successfully |
| Pending | Waiting to be processed |
| Retrying | Waiting for a retry |
| Failed Final | Errors that are not retried automatically |
| Dead Letter | Retries exhausted |
| Success Rate | Percentage of deliveries completed successfully |
| Event Trend | Hourly/daily chart |
| Failed Endpoints | Endpoints with the most errors |
| Recent Events | The 10–20 most recent events |

Global filters: Project, Environment, time range of 24 hours / 7 days / 30 days.

### 4.2. Projects

- Create, edit, and disable projects.
- Each project has multiple webhook sources and destinations.
- View webhook statistics per project.
- Never hard-delete a project that has delivery history.

### 4.3. Endpoints

| Field | Description |
|---|---|
| Name | Endpoint name |
| Project | Owning project |
| Source URL | Public webhook URL |
| Destination URL | Backend URL that receives the webhook |
| Authentication | HMAC, Token, or provider-specific |
| Status | Active / Paused / Disabled |
| Timeout | Response wait time |
| Last Delivery | Most recent delivery |
| Success Rate | Success percentage |
| Last Error | Most recent error |

Actions: Create, Edit, Rotate Secret, Test Delivery, Pause, Resume.

### 4.4. Webhook Events

Main events table:

| Column | Value |
|---|---|
| Received At | Date and time received |
| Event ID | Unique identifier |
| Project | Project |
| Source | Sender |
| Destination | Target backend |
| Status | Current status |
| HTTP Status | Latest HTTP code |
| Attempts | Number of attempts |
| Next Retry | Next retry time |

Supports searching by Event ID and Provider Event ID, and filtering by project, source, status, HTTP code, and time range. Uses cursor-based pagination.

### 4.5. Event Detail

Each event has a detail screen containing:

- Event metadata and provider event ID.
- Request headers with secrets removed.
- Raw payload / JSON viewer, subject to access permissions.
- Payload SHA-256.
- Delivery timeline.
- Number of attempts and retry times.
- HTTP response status, duration, and error message.
- **Replay Webhook** and Copy Event ID buttons.

Example timeline:

```text
10:00:00  Received          202 Accepted
10:00:02  Attempt #1       503 Service Unavailable
10:00:32  Attempt #2       Connection Timeout
10:02:32  Attempt #3       200 OK
10:02:33  Delivered        Success
```

### 4.6. Failed & Dead Letter

A dedicated error management page with two groups:

- **Failed Final:** errors that are not retried automatically, e.g. `401` or `404`.
- **Dead Letter:** webhooks that exhausted their retries under the policy.

Allows filtering by failure reason, viewing the payload and history, and replaying a single event or a bounded batch of events. Every replay must be audited.

### 4.7. Settings & Audit

Manage retention, retry, alert, and permission policies. The audit log records the actor, action, resource, time, replay reason, and the change diff with secrets removed.

## 5. Retry Policy

| Condition | Behavior |
|---|---|
| HTTP 2xx | Mark Delivered, ACK |
| HTTP 408 | Retry |
| HTTP 429 | Retry, prefer Retry-After |
| HTTP 5xx | Retry |
| Network Failure | Retry |
| Connection Timeout | Retry |
| HTTP 3xx | Failed Final by default, do not follow redirects |
| HTTP 4xx other than 408/429 | Failed Final |
| Retries exhausted | Move to native DLQ |

Initial configuration:

- Timeout: 10 seconds.
- Backoff: starts at 30 seconds, grows exponentially.
- Jitter: ±20%.
- Maximum backoff: 6 hours.
- Queue max retries: 20.
- Queue retention: 14 days on the Paid plan.
- Queue batch: 10 messages.
- Consumer concurrency: start at 5, benchmark before increasing.

If an endpoint is Paused, its jobs are held in D1 and re-enqueued after Resume, instead of retrying continuously.

## 6. Database Schema

| Table | Purpose |
|---|---|
| `projects` | Project information |
| `sources` | Webhook sources and authentication methods |
| `destinations` | Target backends and delivery settings |
| `webhook_events` | Ledger of received events, payload reference |
| `deliveries` | Delivery jobs, including replays |
| `delivery_attempts` | Log of each HTTP attempt |
| `audit_logs` | Administrative action history |
| `alerts` | Detected incidents |

Required keys and relationships:

- `webhook_events.source_id -> sources.id`
- `deliveries.event_id -> webhook_events.id`
- `deliveries.destination_id -> destinations.id`
- `delivery_attempts.delivery_id -> deliveries.id`
- Unique provider event ID per source when a trustworthy ID exists.
- Indexes for filtering by status, time, project, and retry due time.

D1 is the source of truth. Small payloads (up to 64 KB) may be stored inline; large payloads are stored in a private R2 bucket and referenced by `r2_key`. An event must not be acknowledged until it has been durably written.

## 7. REST API

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/in/:sourceId` | Receive webhook |
| GET | `/api/admin/v1/overview` | Dashboard statistics |
| GET/POST | `/api/admin/v1/projects` | Manage projects |
| GET/POST | `/api/admin/v1/sources` | Manage sources |
| GET/POST | `/api/admin/v1/destinations` | Manage destinations |
| PATCH | `/api/admin/v1/destinations/:id` | Update/pause/resume |
| POST | `/api/admin/v1/destinations/:id/test` | Test delivery |
| GET | `/api/admin/v1/events` | Search delivery logs |
| GET | `/api/admin/v1/events/:id` | Event detail |
| GET | `/api/admin/v1/events/:id/deliveries` | Delivery timeline |
| POST | `/api/admin/v1/events/:id/replay` | Manual replay |
| GET | `/api/admin/v1/failures` | Failed / DLQ list |
| GET | `/api/admin/v1/audit-logs` | Audit history |
| GET/PATCH | `/api/admin/v1/settings` | System settings |

Every admin API must be protected by Cloudflare Access and server-side RBAC.

## 8. Security Requirements

- Validate source signatures on the raw body; do not parse/re-serialize before verifying.
- Encrypt dynamic secrets stored in D1 with a key taken from Worker Secrets.
- Outbound webhooks use a dedicated HMAC between the gateway and the backend.
- Allow only HTTPS destinations; do not follow redirects.
- Prevent SSRF, private IPs, localhost, and metadata endpoints.
- Do not forward credential-bearing headers from the sender.
- Rate limit and cap request body size.
- Redact secrets, tokens, and sensitive data in the dashboard and logs.
- Admin roles: Admin, Operator, Viewer.
- Separate D1/R2/Queues for staging and production.
- Backends must process idempotently using `X-Webhook-Event-ID`.

## 9. Reliability & Operations

| Failure case | Requirement |
|---|---|
| D1 unavailable | Return 503, do not acknowledge the webhook |
| R2 unavailable | Return 503 for payloads that depend on R2 |
| Queue unavailable | Return 503, Reconciler recovers from D1 |
| Backend down | Automatic retry |
| Backend overloaded | 429/backoff |
| Delivery Worker crash | Queue redelivery + lease |
| Delivery succeeds but D1 update fails | Possible duplicate delivery; backend is idempotent |
| Queue retries exhausted | DLQ + D1 log + alert |
| Duplicate queue message | Check terminal state/lease |
| Payload expired | Do not replay when the raw payload is missing |

Implement a Cron Reconciler that periodically checks pending jobs, enqueue failures, expired leases, and overdue retries, with a cooldown so it does not create mass duplicate messages.

## 10. Retention & Monitoring

| Data | Default |
|---|---|
| Delivered payload | 30 days |
| Failed/DLQ payload | 90 days or until handling is complete |
| Event metadata/attempt logs | 180 days |
| Audit logs | 365 days |
| Queue retention | 14 days |
| Cleanup | Daily |

Monitor error rate, pending age, retry count, DLQ, D1 usage, Queue backlog, and system errors. Alert when an endpoint fails 5 times in a row, when a new DLQ entry appears, or when an event has been pending for more than 5 minutes.

Back up D1 and test restores. Use external uptime monitoring to detect incidents that cannot be observed from inside Cloudflare.

## 11. Acceptance Criteria

- [ ] When the backend is offline, the gateway still receives and stores webhooks.
- [ ] Never return 202 before D1/R2/Queue have finished writing the required data.
- [ ] When the backend recovers after 48 hours, webhooks are retried and processed.
- [ ] Duplicate webhooks do not create duplicate logical events when a provider event ID is available.
- [ ] Every delivery has a history of HTTP status, latency, and errors.
- [ ] The Dead Letter Queue is reflected on the dashboard.
- [ ] Manual replay works and preserves the previous delivery history.
- [ ] The Reconciler recovers from partial failures.
- [ ] Admins can create and fully configure projects, sources, and destinations from the UI.
- [ ] The Admin API is protected by Access and RBAC.
- [ ] Tests exist for D1/Queue failure, timeout, retry, duplicates, and SSRF.
- [ ] An operations runbook, migrations, backup/restore, and rollback exist.

## 12. Delivery Phases

| Phase | Scope |
|---|---|
| Phase 1 | Core receiver, D1 ledger, Queue, delivery |
| Phase 2 | Retry, DLQ, idempotency, reconciler, R2 |
| Phase 3 | Admin dashboard, Access, RBAC, replay, audit |
| Phase 4 | Alerting, retention, benchmark, backup, and production readiness |

**Out of MVP scope:** webhook transformations, multi-destination fan-out, SaaS billing, workflow editor, Kafka/NATS/Temporal, and a realtime WebSocket dashboard.

The whole system must be optimized for reliability, auditability, and low operating cost, without adding components that only increase complexity.
